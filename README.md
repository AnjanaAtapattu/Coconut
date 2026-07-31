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
| **Your land** | Soil and climate for a chosen point, and an irrigation guide derived from the two together |

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

## Irrigation guidance

The one thing neither dataset answers alone. Rainfall says how much water arrives;
available water capacity says how much of it the soil holds for the palm to draw on
afterwards. Running a monthly balance over the two gives the months where rainfall
falls short *and* the soil store is already spent — which is when irrigation is
actually needed, rather than simply when it is dry.

The balance is spun up over a preceding year before anything is reported. Starting
cold in January discards the October–December recharge, which is exactly the water a
palm lives on through the following dry season; without the spin-up the soil made no
difference to the result at all.

Two assumptions are stated in the output rather than hidden: crop demand of 130 mm per
month, and a 10 m² basin when converting the shortfall to litres per palm. Both are
mid-range CRI figures and easy to adjust at the top of the function.

## Soil grid

`soil-grid.bin` holds seven bytes per cell — pH, sand %, silt %, plant-available water
in mm over the top metre, organic carbon %, cation exchange capacity and bulk density —
on a ~2 km grid covering the island. It is built from 45 national soil rasters (nine
properties at five depths, about 23 MB) by:

```bash
python3 tools/build_soilgrid.py --rasters DIR   # rebuild from the .tif rasters
python3 tools/build_soilgrid.py --check         # verify the file and metadata agree
```

The rasters themselves are not committed: they are large, and the app only needs the
reduction. Keep them somewhere retrievable if the grid ever has to be rebuilt.

pH and texture are averaged over 0–30 cm, where amendments are worked in; available
water is summed over the full 0–100 cm, because a palm draws on the whole profile
between rains. The file is precached with the app shell, so soil lookups work with no
signal.

Clay is not stored. The three texture fractions are a closed composition in this
dataset — measured clay equals `100 − sand − silt` exactly in every cell — so a clay
channel would cost 26 kB and tell the reader nothing it cannot derive.

Available-water thresholds are calibrated to this grid rather than to textbook figures:
these soils hold 32–76 mm per metre (median 52), so a generic "under 150 mm is low"
would have labelled nearly every holding in the country poor. Organic carbon keeps its
standard agronomic breaks, because unlike available water 1% carbon means the same
thing anywhere, and these soils genuinely are low in it. Bulk density is judged against
texture, since a sand can carry a density that would already restrict roots in a clay.

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

## External data services

Three services are used, and none of them is required for the app to work — every one
degrades to built-in data if it is unreachable, because the audience is offline often.

**NASA POWER** (`power.larc.nasa.gov`) supplies 30-year monthly climatology per
coordinate: rainfall, temperature, humidity, solar radiation and wind. No key, and the
service is CORS-enabled. Responses are cached in `localStorage` by rounded coordinate
and by the service worker. Falls back to the built-in three-zone climatology.

**CROPIX** (Department of Agriculture) supplies administrative divisions — districts,
DS divisions, GN divisions and Agrarian Service Centres — used for the locality picker
in the Offices tab, and the soil vocabulary (`/soil-types`, `/soil-sub-types`).
Endpoint paths come from the published public API listing.

Soil names are the one case where the app defers entirely to this service. They are
international taxonomy that extension officers use in English, so the app never coins
its own Sinhala or Tamil equivalents: if the department's records carry local names
those are used, and if they do not the English is kept.

> **Known blocker:** the listing gives the base URL as `http://data.doa.gov.lk`, over
> plain HTTP. This app is served over HTTPS, and browsers block plain-HTTP requests
> from an HTTPS page outright, so `https://data.doa.gov.lk` is requested instead. If
> that host does not answer on TLS these calls will fail and the picker will quietly
> fall back to the district list bundled with the app. Confirm whether the gateway
> serves HTTPS before relying on it; if it does not, the options are a proxy or asking
> the department to enable TLS.

The CROPIX public API has **no weather or agro-meteorological endpoints** — it covers
geography, crops, seasons, soil, seed certification and crop-look statistics. The
weekly agro-met advisory at `doa.gov.lk/agro-met-advisory/` is a web page rather than
a feed and does not send CORS headers, so the app links out to it rather than
attempting to read it.

Response shapes are not documented in the listing, so records are read tolerantly: the
array may arrive bare or wrapped in `data`, `result.content` and similar, and a name
may be `name`, `nameEn`, `districtName` and so on. Anything unrecognised is skipped
rather than guessed at.

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
