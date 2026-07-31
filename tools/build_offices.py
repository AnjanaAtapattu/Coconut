#!/usr/bin/env python3
"""Regenerate the office and mite-packet data in index.html from tools/data/*.csv.

The office list, and the district lookup on the Coconut Mite card, are both derived
data. Editing them by hand in index.html means the next spreadsheet import silently
reintroduces whatever was fixed, so this script owns the transformation instead.

    python3 tools/build_offices.py            # rewrite index.html in place
    python3 tools/build_offices.py --check    # report drift, change nothing (CI-safe)

Cleaning applied on the way through, each of which was a real defect in the source:
  * phone numbers with two values run together into one unusable string
  * missing leading zero on local numbers
  * a district name carrying a diacritic, so it never matched a lookup
  * place names transliterated inconsistently between files
  * one office serving several districts appearing once per district
"""

import argparse
import csv
import io
import json
import pathlib
import re
import sys
from collections import OrderedDict, defaultdict

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "tools" / "data"
INDEX = ROOT / "index.html"

# Only unambiguous corrections belong here. "Monaragala" and "Moneragala" are both in
# official use for that district, so neither is rewritten to the other.
SPELLING = {
    "Nusery": "Nursery",
    "Hambanthota": "Hambantota",
    "Hambanotota": "Hambantota",
    "Rathnapura": "Ratnapura",
    "Trincomelee": "Trincomalee",
    "Anuradapura": "Anuradhapura",
    "Baththuluoya": "Battuluoya",
    "Mulativ": "Mullaitivu",
    "Hambantoṭa": "Hambantota",  # diacritic in the mite-packet sheet
}

ICONS = {"CRI": "\U0001f52c", "CCB": "\U0001f3db️", "Nursery": "\U0001f331",
         "Training": "\U0001f393", "Garden": "\U0001f334", "CDA": "\U0001f3e2"}

# Not in any spreadsheet; transcribed from CDA_Office_Locations_Sri_Lanka.xlsx.
CDA_OFFICES = [
    ("Coconut Development Authority (Head Office)", "Colombo", 6.8909, 79.8766,
     "0112502502", "54, Nawala Road, Narahenpita, Colombo 05"),
    ("CDA Fort Office", "Colombo", 6.9365, 79.8448,
     "0112421028", "11, Duke Street, Colombo 01"),
    ("CDA Regional Office Kurunegala", "Kurunegala", 7.4863, 80.3647,
     "0372222534", "Kurunegala"),
]


def clean(s):
    s = re.sub(r"\s+", " ", (s or "")).strip().strip(",")
    for bad, good in SPELLING.items():
        s = s.replace(bad, good)
    return s


def phone(s):
    """First usable number. Sheets sometimes hold two, separated inconsistently."""
    s = (s or "").strip()
    first = re.split(r"[,/;]| or ", s)[0]
    digits = re.sub(r"[^\d]", "", first)
    # Two 10-digit numbers concatenated with no separator at all.
    if len(digits) > 11 and len(digits) % 10 == 0:
        digits = digits[:10]
    if not digits:
        return ""
    if not digits.startswith("0"):
        digits = "0" + digits
    return digits


def num(v):
    try:
        return round(float(v), 5)
    except (TypeError, ValueError):
        return None


def rows(name):
    path = DATA / name
    if not path.exists():
        sys.exit("missing source file: %s" % path)
    return list(csv.DictReader(io.StringIO(path.read_text(encoding="utf-8-sig"))))


def build_offices():
    out, seen = [], set()

    def add(name, typ, lat, lng, addr, ph, district=None):
        if lat is None or lng is None or not name:
            return
        key = (typ, round(lat, 4), round(lng, 4))
        if key in seen:          # same site listed under several districts
            return
        seen.add(key)
        rec = OrderedDict([("name", name), ("type", typ), ("lat", lat), ("lng", lng),
                           ("addr", addr), ("phone", ph), ("icon", ICONS[typ])])
        if district:
            rec["district"] = district
        out.append(rec)

    for r in rows("cri_estates.csv"):
        add(clean(r["Estate / Station Name"]), "CRI", num(r["Latitude"]), num(r["Longitude"]),
            clean(r["Address"]), phone(r["Contact Number"]), clean(r.get("District", "")))

    served = defaultdict(set)
    ro = rows("regional_offices_by_district.csv")
    for r in ro:
        served[clean(r["Regional Office Name"])].add(clean(r["Selected District"]))
    for r in ro:
        nm = clean(r["Regional Office Name"])
        add("CCB " + nm, "CCB", num(r["Latitude"]), num(r["Longitude"]),
            clean(r["Office Address"]), phone(r["Office Contact No"]),
            ", ".join(sorted(served[nm])))

    for r in rows("coconut_nurseries.csv"):
        add(clean(r["Nursery Name"]), "Nursery", num(r["Latitude"]), num(r["Longitude"]),
            clean(r["Address"]), phone(r["Contact Number"]))

    for r in rows("coconut_training_centers.csv"):
        add(clean(r["Training Center Name"]), "Training", num(r["Latitude"]),
            num(r["Longitude"]), clean(r["Address"]), phone(r["Contact Number"]))

    for r in rows("coconut_model_gardens.csv"):
        nm = clean(r["Garden Name"])
        if nm:
            add(nm + " Model Garden", "Garden", num(r["Latitude"]), num(r["Longitude"]),
                clean(r["Address"]), phone(r["Contact Number"]))

    for nm, dist, la, lo, ph, ad in CDA_OFFICES:
        add(nm, "CDA", la, lo, ad, ph, dist)

    return out


def build_mite():
    packets = OrderedDict()
    for r in rows("mite_packet_locations.csv"):
        district = clean(r["District"])
        name = clean(r["Name"])
        if clean(r["Type"]) == "Regional Office" and not name.lower().endswith("office"):
            name = "CCB " + name
        packets.setdefault(district, []).append(OrderedDict([
            ("n", name), ("p", phone(r["Contact Number"])),
            ("lat", num(r["Latitude"])), ("lng", num(r["Longitude"]))]))
    return packets


def js_offices(offices):
    lines = []
    for o in offices:
        parts = ["name:%s" % json.dumps(o["name"], ensure_ascii=False),
                 "type:%s" % json.dumps(o["type"]),
                 "lat:%s" % o["lat"], "lng:%s" % o["lng"],
                 "addr:%s" % json.dumps(o["addr"], ensure_ascii=False),
                 "phone:%s" % json.dumps(o["phone"]),
                 "icon:%s" % json.dumps(o["icon"], ensure_ascii=False)]
        if "district" in o:
            parts.append("district:%s" % json.dumps(o["district"], ensure_ascii=False))
        lines.append("{" + ",".join(parts) + "}")
    return "var OFFICES=[\n" + ",\n".join(lines) + "\n];"


def replace_block(html, pattern, replacement, label):
    m = re.search(pattern, html, re.S)
    if not m:
        sys.exit("could not locate %s in index.html" % label)
    return html[:m.start()] + replacement + html[m.end():], m.group(0) != replacement


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="exit non-zero if index.html differs from the CSVs")
    args = ap.parse_args()

    offices, mite = build_offices(), build_mite()
    html = INDEX.read_text(encoding="utf-8")

    html, off_changed = replace_block(
        html, r"var OFFICES=\[.*?\n\];", js_offices(offices), "OFFICES")
    html, mite_changed = replace_block(
        html, r"var MITE_PACKETS=\{.*?\};",
        "var MITE_PACKETS=" + json.dumps(mite, ensure_ascii=False, separators=(",", ":")) + ";",
        "MITE_PACKETS")

    counts = defaultdict(int)
    for o in offices:
        counts[o["type"]] += 1
    summary = ", ".join("%s %s" % (v, k) for k, v in sorted(counts.items()))
    print("%d offices (%s); mite packets for %d districts" % (len(offices), summary, len(mite)))

    if args.check:
        if off_changed or mite_changed:
            sys.exit("index.html is out of date: run python3 tools/build_offices.py")
        print("index.html matches the source CSVs")
        return

    INDEX.write_text(html, encoding="utf-8")
    print("wrote", INDEX.relative_to(ROOT))


if __name__ == "__main__":
    main()
