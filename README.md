# Burning Calendar

**One consistent fire record from two generations of NASA satellites.**
NASA Space Apps Challenge 2026 — *Harmonization of MODIS and VIIRS Hot Spots*.

Live site: **https://sunders.earth**

## The problem

NASA FIRMS publishes active-fire hotspots from two instruments:

- **MODIS** (Terra since 2000, Aqua since 2002) — 1 km pixels.
- **VIIRS** (S-NPP since 2012, NOAA-20, NOAA-21) — 375 m pixels.

VIIRS sees more detail, so for the same fires it reports **about 4.3 times as many hotspots**
as MODIS (measured in this project's data). Put both on one chart and the record jumps
where the instrument changes, not where burning changes. As MODIS retires, any long-term
fire record has to cross that seam.

## What we built

1. **A harmonization pipeline** (Python, DuckDB, Parquet) that converts VIIRS hotspots into
   *MODIS-equivalent* hotspots, separately for every 1° tile and month of the year, using
   whichever of three methods (quantile mapping, Theil–Sen, ratio) predicts best on
   held-out years. Every result carries an uncertainty band.
2. **A website, the "burning calendar"**: a world map of recent hotspots plus a
   month × year calendar of harmonized fire activity for any area you choose — one of 25 quick
   areas (continents and well-known fire regions), a rectangle, a polygon or a point with a
   radius. Each square shows its value; a "compared with usual" mode shows how each month differs
   from the same month in other years. Charts (seasonal profile, year by year, MODIS vs VIIRS),
   plain-language reading guides, CSV and Excel downloads and shareable links. All calculations
   run in the browser; there is no server to maintain.

## Results (held-out years, whole world)

| | Years tested | Raw VIIRS vs MODIS | Harmonized vs MODIS | Correlation |
|---|---:|---:|---:|---:|
| S-NPP | 2012–2026 | +314% | +1.2% | 0.994 |
| NOAA-20 | 2018–2026 | +324% | +1.1% | 0.994 |
| NOAA-21 | 2023–2026 | +324% | +0.5% | 0.991 |

Over 2012–2025 the harmonized world total matches MODIS to 0.1%. Single months for a single
30° block are less exact (median error ≈ 11–15%). Full tables
and caveats: **[VALIDATION.md](VALIDATION.md)**. What it can't do: **[LIMITATIONS.md](LIMITATIONS.md)**.

## Data

All fire data comes from **NASA FIRMS** (MODIS Collection 6.1, VIIRS 375 m Collection 2:
S-NPP, NOAA-20, NOAA-21), whole world, **1 Nov 2000 – 13 Nov 2026**: FIRMS yearly country
archives for 2000–2022 and FIRMS archive downloads from 13 Nov 2022. 662.8 million
detections, 591.3 million after cleaning and duplicate removal. No other fire data is used,
and none is made up. How to get the files: [docs/DATA_DOWNLOAD.md](docs/DATA_DOWNLOAD.md).

## Method in one paragraph

Detections are cleaned (confidence thresholds, non-vegetation sources removed, duplicates
and superseded near-real-time rows dropped), counted on a shared 0.1° daily grid, and
summed per 1° tile and month. For each VIIRS satellite, a transfer to MODIS (Terra + Aqua)
is fitted with three methods and chosen by leave-one-year-out error, falling back from
tile to world block to global fits where data is thin. The final monthly series is
VIIRS-derived throughout, so it never jumps when MODIS ends. Details:
**[METHODS.md](METHODS.md)**.

## Repository

```
config/pipeline.toml      every threshold and setting
pipeline/                 Python pipeline
  ingest_global.py        FIRMS zips -> cleaned Parquet, per 30° world block
  grid.py                 daily 0.1° grid, active cell-days
  transfer.py             the three VIIRS->MODIS methods
  validate.py             leave-one-year-out validation
  harmonize.py            final monthly series, gaps, method choice
  uncertainty.py          5–95% band from held-out errors
  export_static.py        compact binary files for the website
  run.py                  command line (python -m pipeline.run ...)
web/                      website (React, TypeScript, Vite, MapLibre)
  src/api.ts              all calculations, in the browser
  src/App.tsx             layout: controls (left), map, results under the map
  src/areas.ts            the quick areas in the area menu
  src/components/         map, calendar, charts, reading guides, loading screen
scripts/                  upload data to Cloudflare R2
docs/                     data download, deployment
tests/                    pytest (uses clearly labelled synthetic data only)
```

## Run it yourself (Windows, PowerShell)

```
py -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
cd web; npm install; cd ..

# put the FIRMS DL_FIRE_*.zip files in data/drive/ and the yearly *_all_countries.zip
# files in data/drive_part1/, then:
.venv\Scripts\python -m pipeline.run all --no-figures     # several hours for 2000–2026 on a laptop
.venv\Scripts\python -m pipeline.run export-static        # writes web/public/data
cd web; npm run dev                                        # http://localhost:5173
```

Tests: `.venv\Scripts\python -m pytest tests`. Publishing online (Cloudflare Pages + R2):
[docs/DEPLOY_CLOUDFLARE.md](docs/DEPLOY_CLOUDFLARE.md).

## Credits and citation

We acknowledge the use of data and imagery from LANCE FIRMS operated by NASA's Goddard
Space Flight Center Earth Science Data and Information System (ESDIS) with funding
provided by NASA Headquarters. FIRMS: https://firms.modaps.eosdis.nasa.gov/

Map backgrounds: Sentinel-2 cloudless and OpenStreetMap layers by EOX (Sentinel-2 cloudless
is CC BY-NC-SA 4.0); Blue Marble, Black Marble and daily imagery from NASA GIBS.

This is an independent Space Apps Challenge project. It is not an official NASA product.
