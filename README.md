# Pol Sathkara — Coconut Zone Guide

Site-specific coconut growing guidance for Sri Lanka, in Sinhala, Tamil and English.

Live: <https://anjanaatapattu.github.io/Coconut/>

Built for growers on intermittent rural connections, which drives most of the design
decisions below: the whole app is one file, every dependency is served from this
repository, and it keeps working once loaded even with no signal.

## What's in it

| | |
|---|---|
| **Google Map** | Satellite view; drop a pin to find your zone, or show all 86 offices as map pins |
| **Agro-Ecological / Climatic Zones** | Tap a zone for varieties, yields, fertiliser schedules and intercrops |
| **Weather** | Rainfall by zone and month, plus a seasonal calendar |
| **Pests** | Pests and diseases side by side, a photo comparison aid, and where to collect mite packets by district |
| **Offices** | CRI stations, CCB regional offices, nurseries, training centres, model gardens and CDA offices, sorted by distance from your GPS position |

Also: trilingual interface, an offline assistant, dark mode, adjustable text size,
printable zone reports, and per-crop CRI guides as PDFs.

## Layout

```
index.html              the entire app — markup, styles, script and zone data
sw.js                   service worker (offline behaviour, caching)
manifest.webmanifest    PWA manifest
vendor/leaflet/         Leaflet 1.9.4, vendored (BSD-2-Clause)
intercrop-pdfs/         23 CRI crop guides, one per crop
tools/build_offices.py  regenerates office data from the CSVs
tools/data/*.csv        source records for offices and mite packets
```

`index.html` is around 1 MB (265 KB gzipped), mostly the two inline GeoJSON layers.
They are inline on purpose: it keeps the app to a single request and makes offline
caching trivial. Coordinates are already at 5 decimal places, so there is nothing to
reclaim by trimming precision.

## Updating office data

The office list and the mite-packet district lookup are **generated**. Edit the CSVs
in `tools/data/`, then:

```bash
python3 tools/build_offices.py          # rewrite index.html from the CSVs
python3 tools/build_offices.py --check  # report drift without changing anything
```

Do not hand-edit `var OFFICES` or `var MITE_PACKETS` in `index.html` — the next run
overwrites them. The script also cleans problems that recur in the source
spreadsheets: phone numbers with two values run together, missing leading zeros,
a district name carrying a diacritic that stopped it matching, inconsistent
transliterations, and one office repeated once per district it serves.

Only unambiguous spelling corrections are applied. `Monaragala` and `Moneragala` are
both left alone because both are in official use; search matches either spelling.

## Offline behaviour

The service worker caches in layers, because the pieces have different lifetimes:

- **App shell** (HTML, Leaflet, icons) — precached on install. Navigations are
  network-first, so a deploy is always picked up when online, with the cached shell
  as the fallback when not.
- **Map tiles** — cached as viewed, capped at 400 so browsing cannot fill the disk.
- **Crop guide PDFs** — cached on first open, never precached. Together they are
  ~5 MB and a grower needs only the crops they actually grow.

Bump `VERSION` in `sw.js` when shell assets change; the old caches are then dropped
on activation.

The only outbound requests left are map tiles, which cannot be bundled, and Google
Fonts. Blocking the fonts degrades typography but not legibility — Sinhala and Tamil
still render through system fallback.

## Deploying

Pushing to `main` publishes via GitHub Actions (`.github/workflows/deploy-pages.yml`).
There is no build step: what is committed is what is served.

## Working on it locally

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

A plain `file://` open will not work — the service worker and the manifest both need
a real HTTP origin.

## Data sources

Coconut Research Institute (CRI), Coconut Cultivation Board (CCB), and the Coconut
Development Authority (CDA). Market prices are from the CRI Cost of Production survey
of 1–16 June 2026 and are static; update the `prices` array in `index.html` when a
newer survey is published.
