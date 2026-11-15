# Burning Calendar – handoff notes (14 Nov 2026)

NASA Space Apps 2026, "Harmonization of MODIS and VIIRS Hot Spots".
A static website that turns MODIS + VIIRS active-fire detections into one consistent monthly
"burning calendar" for any area of the world, plus the Python pipeline that builds its data.

## Data (only this, nothing else)
- The FIRMS archive-download zips in the Google Drive folder **"Nasa SpaceApps 2026"**
  (`DL_FIRE_*.zip`: MODIS `M-C61`, VIIRS S-NPP `SV-C2`, NOAA-20 `J1V-C2`, NOAA-21 `J2V-C2`;
  the Landsat `LS` zips are not used). Whole world, **13 Nov 2022 – 13 Nov 2026**.
- Put them in `data/drive/` (zips inside zips are fine). `config/pipeline.toml` → `[paths] zips`
  lists the folders that are read.

## Set up (Windows, PowerShell, from this folder)
```
py -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
cd web; npm install; cd ..
```
Node.js LTS is needed for the website.

## Build everything
```
.venv\Scripts\python -m pipeline.run all --no-figures      # ~1 hour for the whole world
.venv\Scripts\python -m pipeline.run export-static         # writes web/public/data
cd web; npm run dev                                         # http://localhost:5173
```
Online: page on Cloudflare Pages, data on Cloudflare R2 – follow `docs/DEPLOY_CLOUDFLARE.md`
(`.\scripts\publish_data.ps1` uploads the data).

## Where things stand
- Done: worldwide pipeline (30° world blocks), harmonization with leave-one-year-out validation,
  static website in the FIRMS-style layout (map + side panel), CSV exports, share links, Cloudflare deployment (Pages + R2).
- Phase 4 (README, VALIDATION.md, LIMITATIONS.md, DEMO_SCRIPT.md, updated METHODS.md and
  docs/DATA_DOWNLOAD.md) written on 15 Nov 2026. All numbers come from the 2022–2026 build;
  rerun the checks in VALIDATION.md and re-read the demo numbers if the data changes.
- Not done yet: Phase 5 (pitch-video prompts for Higgsfield; never spend credits without the
  owner's "yes"). The FastAPI service (`api/`) is not updated for world blocks.

## Rules the owner set
- Never invent data, endpoints or results; mark anything unverified as VERIFY.
- Only the Drive data above. Say where every dataset comes from.
- Keys only from environment variables (`FIRMS_MAP_KEY`, `R2_*`), never in code.

## Map
- `pipeline/` – ingest_global (zips → Parquet per world block), grid, harmonize (+ transfer,
  validate, uncertainty), export_static (files for the website)
- `web/src/` – api.ts (all calculations in the browser), App.tsx (layout), components/
- `api/` – optional FastAPI service (not needed by the website)
- `METHODS.md` – method explained in plain language; `tests/` – `python -m pytest tests`
