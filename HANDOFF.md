# Burning Calendar – handoff notes (15 Nov 2026)

NASA Space Apps 2026, "Harmonization of MODIS and VIIRS Hot Spots".
A static website that turns MODIS + VIIRS active-fire detections into one consistent monthly
"burning calendar" for any area of the world, plus the Python pipeline that builds its data.

## Data (NASA FIRMS only, whole world, 1 Nov 2000 – 13 Nov 2026)
- `data/drive/`: the FIRMS archive-download zips from the Google Drive folder
  **"Nasa SpaceApps 2026"** (`DL_FIRE_*.zip`: MODIS `M-C61`, VIIRS S-NPP `SV-C2`, NOAA-20 `J1V-C2`,
  NOAA-21 `J2V-C2`; Landsat `LS` not used), 13 Nov 2022 – 13 Nov 2026.
- `data/drive_part1/`: FIRMS yearly country archives `modis_<year>_all_countries.zip`
  (2000–2022), `viirs-snpp_…` (2012–2022), `viirs-jpss1_…` (NOAA-20, 2018–2022), from
  `https://firms.modaps.eosdis.nasa.gov/data/country/zips/`. Details: docs/DATA_DOWNLOAD.md.
- `config/pipeline.toml` → `[paths] zips` lists the folders that are read.

## Set up (Windows, PowerShell, from this folder)
```
py -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
cd web; npm install; cd ..
```
Node.js LTS is needed for the website.

## Build everything
```
.venv\Scripts\python -m pipeline.run all --no-figures      # ~5 h ingest + ~1 h rest (16 GB laptop)
.venv\Scripts\python -m pipeline.run export-static         # writes web/public/data
cd web; npm run dev                                         # http://localhost:5173
```
Online: page on Cloudflare Pages, data on Cloudflare R2 – follow `docs/DEPLOY_CLOUDFLARE.md`
(`.\scripts\publish_data.ps1` uploads the data).

## Where things stand
- Done: worldwide pipeline (30° world blocks), harmonization with leave-one-year-out validation,
  static website (controls on the left, map, results under the map; "How it works" window; 25 quick areas), CSV exports, share links, Cloudflare deployment (Pages + R2).
- Phase 4 docs written on 15 Nov 2026, then updated the same day for the 2000–2026 build
  (VALIDATION.md tables recomputed; items marked VERIFY there were not recomputed).
- Speed/size settings: DuckDB memory cap `BURNCAL_DUCKDB_MEMORY` (default 6GB); validation folds
  run in parallel (`BURNCAL_WORKERS`, default all cores but one). Only method or harmonize
  changes? Run `harmonize` + `export-static` (~40 min), not `all`.
- **Open: the 2000–2026 export is 13.9 GB, over the 10 GB R2 free plan.** 12.4 GB of it is
  `r/<block>/hot/` (every detection, for map dates and hotspot downloads); the calendar,
  charts and grids are 1.5 GB.
- Phase 5 of the brief (pitch video) was canceled by the owner on 15 Nov 2026.

## Rules the owner set
- Never invent data, endpoints or results; mark anything unverified as VERIFY.
- Only the NASA FIRMS data above (owner extended it to the yearly archives on 15 Nov 2026).
  Say where every dataset comes from.
- Keys only from environment variables (`R2_*` for the data upload), never in code.

## Map
- `pipeline/` – ingest_global (zips → Parquet per world block), grid, harmonize (+ transfer,
  validate, uncertainty), export_static (files for the website)
- `web/src/` – api.ts (all calculations in the browser), App.tsx (layout), components/
- `METHODS.md` – method explained in plain language; `tests/` – `python -m pytest tests`
