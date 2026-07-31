#!/usr/bin/env python3
"""Build the packed soil grid (soil-grid.bin) from the Sri Lanka soil rasters.

Input is 25 GeoTIFFs — pH, sand, silt, and the two volumetric moisture limits, each
at five depths (0-5, 5-15, 15-30, 30-60, 60-100 cm). Together they are about 13 MB,
which is far too much to ship to a grower on a rural connection, and the app does not
need per-pixel fidelity: it needs to answer "what is the soil like on my land".

So the rasters are reduced here, once, to four bytes per cell:

    pH        depth-weighted mean over 0-30 cm, stored as pH x 20
    sand %    depth-weighted mean over 0-30 cm
    silt %    depth-weighted mean over 0-30 cm
    AWC mm    plant-available water over the full 0-100 cm profile,
              summed as (drainage upper limit - wilting point) x layer thickness

The top 30 cm is used for pH and texture because that is where fertiliser and
amendments are worked in, while available water is summed over the whole metre
because a coconut palm draws on the entire profile between rains.

Cells are averaged 2x2, giving roughly 2 km resolution — well inside the accuracy of
the underlying modelled surfaces, and small enough (about 100 kB) to precache so the
lookup works offline.

    python3 tools/build_soilgrid.py --rasters DIR   # writes soil-grid.bin
    python3 tools/build_soilgrid.py --check         # verify index.html matches

255 marks "no data" in every channel, which is why pH is scaled rather than stored
raw: a real pH never reaches 12.75, so the sentinel can never collide with a reading.
"""

import argparse
import glob
import json
import os
import pathlib
import re
import struct
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"
OUT = ROOT / "soil-grid.bin"

# Layer thickness in mm, matching the five raster depths.
THICK_MM = [50, 100, 150, 300, 400]
# Weights for the 0-30 cm mean: layers 1-3 only.
TOP_W = [5, 10, 15]
DOWNSAMPLE = 2
NODATA = 255

PREFIX = {"ph": "PHOX", "sand": "SNDPPT", "silt": "SLTPPT",
          "dul": "VMC(DUL)", "wp": "VMC(WP)"}


def read_geotiff(path):
    """Minimal reader for the uncompressed, tiled, float32 GeoTIFFs used here."""
    b = open(path, "rb").read()
    en = "<" if b[:2] == b"II" else ">"
    off = struct.unpack(en + "I", b[4:8])[0]
    n = struct.unpack(en + "H", b[off:off + 2])[0]
    tags, sz = {}, {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8}
    for i in range(n):
        e = off + 2 + i * 12
        tag, typ, cnt = struct.unpack(en + "HHI", b[e:e + 8])
        size = sz.get(typ, 1) * cnt
        raw = b[e + 8:e + 8 + size] if size <= 4 else \
            b[struct.unpack(en + "I", b[e + 8:e + 12])[0]:][:size]
        if typ == 3:
            tags[tag] = struct.unpack(en + "%dH" % cnt, raw)
        elif typ == 4:
            tags[tag] = struct.unpack(en + "%dI" % cnt, raw)
        elif typ == 12:
            tags[tag] = struct.unpack(en + "%dd" % cnt, raw)
        elif typ == 2:
            tags[tag] = raw.decode("ascii", "replace").strip("\x00")
        else:
            tags[tag] = raw

    w, h = tags[256][0], tags[257][0]
    tw, th = tags[322][0], tags[323][0]
    toff, tcnt = tags[324], tags[325]
    scale, tie = tags[33550], tags[33922]
    across = (w + tw - 1) // tw
    grid = [[None] * w for _ in range(h)]
    for ti in range(len(toff)):
        tx, ty = (ti % across) * tw, (ti // across) * th
        data = b[toff[ti]:toff[ti] + tcnt[ti]]
        vals = struct.unpack(en + "%df" % (len(data) // 4), data[:len(data) // 4 * 4])
        for r in range(th):
            base = r * tw
            for c in range(tw):
                y, x = ty + r, tx + c
                if y < h and x < w:
                    v = vals[base + c]
                    # The rasters use a large negative sentinel for no data.
                    grid[y][x] = None if (v <= -1e30 or v != v) else v
    return {"w": w, "h": h, "grid": grid, "originX": tie[3], "originY": tie[4],
            "px": scale[0], "py": scale[1]}


def find(rasters, prefix, layer):
    hits = glob.glob(os.path.join(rasters, "**", "%s_OB_SLK_SL%d.tif" % (prefix, layer)),
                     recursive=True)
    if not hits:
        sys.exit("missing raster: %s_OB_SLK_SL%d.tif under %s" % (prefix, layer, rasters))
    return hits[0]


def weighted(layers, weights, y, x):
    total = num = 0.0
    for g, wt in zip(layers, weights):
        v = g["grid"][y][x]
        if v is None:
            return None
        total += v * wt
        num += wt
    return total / num if num else None


def build(rasters):
    print("reading 25 rasters…")
    data = {k: [read_geotiff(find(rasters, p, i)) for i in range(1, 6)]
            for k, p in PREFIX.items()}
    ref = data["ph"][0]
    w, h = ref["w"], ref["h"]

    ow, oh = (w + DOWNSAMPLE - 1) // DOWNSAMPLE, (h + DOWNSAMPLE - 1) // DOWNSAMPLE
    out = bytearray([NODATA]) * (ow * oh * 4)

    for oy in range(oh):
        for ox in range(ow):
            acc = {"ph": [], "sand": [], "silt": [], "awc": []}
            for dy in range(DOWNSAMPLE):
                for dx in range(DOWNSAMPLE):
                    y, x = oy * DOWNSAMPLE + dy, ox * DOWNSAMPLE + dx
                    if y >= h or x >= w:
                        continue
                    for key in ("ph", "sand", "silt"):
                        v = weighted(data[key][:3], TOP_W, y, x)
                        if v is not None:
                            acc[key].append(v)
                    mm = 0.0
                    ok = True
                    for i in range(5):
                        d = data["dul"][i]["grid"][y][x]
                        p = data["wp"][i]["grid"][y][x]
                        if d is None or p is None:
                            ok = False
                            break
                        mm += max(d - p, 0.0) * THICK_MM[i]
                    if ok:
                        acc["awc"].append(mm)

            base = (oy * ow + ox) * 4
            if acc["ph"]:
                out[base] = min(int(round(sum(acc["ph"]) / len(acc["ph"]) * 20)), 254)
            if acc["sand"]:
                out[base + 1] = min(int(round(sum(acc["sand"]) / len(acc["sand"]))), 254)
            if acc["silt"]:
                out[base + 2] = min(int(round(sum(acc["silt"]) / len(acc["silt"]))), 254)
            if acc["awc"]:
                out[base + 3] = min(int(round(sum(acc["awc"]) / len(acc["awc"]))), 254)

    meta = {"w": ow, "h": oh,
            "originX": round(ref["originX"], 8), "originY": round(ref["originY"], 8),
            "px": round(ref["px"] * DOWNSAMPLE, 10), "py": round(ref["py"] * DOWNSAMPLE, 10)}
    return bytes(out), meta


def patch_index(meta, nbytes):
    html = INDEX.read_text(encoding="utf-8")
    block = "var SOIL_GRID_META=%s;" % json.dumps(meta, separators=(",", ":"))
    new, count = re.subn(r"var SOIL_GRID_META=\{.*?\};", block, html, count=1, flags=re.S)
    if not count:
        sys.exit("SOIL_GRID_META not found in index.html")
    changed = new != html
    INDEX.write_text(new, encoding="utf-8")
    return changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rasters", default=os.environ.get("SOIL_RASTERS", "soilrasters"),
                    help="directory holding the extracted *_OB_SLK_SL*.tif files")
    ap.add_argument("--check", action="store_true",
                    help="verify soil-grid.bin and index.html agree, change nothing")
    args = ap.parse_args()

    if args.check:
        if not OUT.exists():
            sys.exit("soil-grid.bin is missing")
        html = INDEX.read_text(encoding="utf-8")
        m = re.search(r"var SOIL_GRID_META=(\{.*?\});", html, re.S)
        if not m:
            sys.exit("SOIL_GRID_META not found in index.html")
        meta = json.loads(m.group(1))
        expected = meta["w"] * meta["h"] * 4
        actual = OUT.stat().st_size
        if expected != actual:
            sys.exit("soil-grid.bin is %d bytes, metadata implies %d" % (actual, expected))
        print("soil-grid.bin %d bytes, %dx%d cells — consistent" % (actual, meta["w"], meta["h"]))
        return

    blob, meta = build(args.rasters)
    OUT.write_bytes(blob)
    patch_index(meta, len(blob))
    print("wrote %s (%d bytes, %dx%d cells at %.4f deg)" %
          (OUT.name, len(blob), meta["w"], meta["h"], meta["px"]))


if __name__ == "__main__":
    main()
