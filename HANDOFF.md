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
For GoDaddy: `.\scripts\build_site.ps1`, then follow `docs/DEPLOY_GODADDY.md`.

## Where things stand
- Done: worldwide pipeline (30° world blocks), harmonization with leave-one-year-out validation,
  static website in the FIRMS-style layout (map + side panel), CSV exports, share links, GoDaddy build.
- In progress when this was written: the first worldwide run (ingest → grid → harmonize). If the
  site says "index.json could not be loaded", the run and `export-static` have not finished yet.
- Not done yet: Phase 4 of the brief (README, validation results, limitations, 90-second demo
  script) and Phase 5 (pitch-video prompts for Higgsfield; never spend credits without the owner's "yes").

## Rules the owner set
- Never invent data, endpoints or results; mark anything unverified as VERIFY.
- Only the Drive data above. Say where every dataset comes from.
- Keys only from environment variables (`FIRMS_MAP_KEY`), never in code.

## Map
- `pipeline/` – ingest_global (zips → Parquet per world block), grid, harmonize (+ transfer,
  validate, uncertainty), export_static (files for the website)
- `web/src/` – api.ts (all calculations in the browser), App.tsx (layout), components/
- `api/` – optional FastAPI service (not needed by the website)
- `METHODS.md` – method explained in plain language; `tests/` – `python -m pytest tests`
