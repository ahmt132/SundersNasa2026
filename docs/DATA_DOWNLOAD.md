# Getting the data

## What the live site uses (worldwide, 13 Nov 2022 – 13 Nov 2026)

The site is built from FIRMS **Archive Download** files for the whole world, one request
per sensor, kept in the team's Google Drive folder "Nasa SpaceApps 2026":

| File name pattern | Sensor |
|---|---|
| `DL_FIRE_M-C61_<id>.zip` | MODIS Collection 6.1 (Terra + Aqua) |
| `DL_FIRE_SV-C2_<id>.zip` | VIIRS S-NPP, Collection 2 |
| `DL_FIRE_J1V-C2_<id>.zip` | VIIRS NOAA-20, Collection 2 |
| `DL_FIRE_J2V-C2_<id>.zip` | VIIRS NOAA-21, Collection 2 |
| `DL_FIRE_LS_<id>.zip` | Landsat (not used) |

Each zip holds `fire_archive_*.csv` (standard processing) and, for the newest months,
`fire_nrt_*.csv` (near-real-time). To rebuild: put the zips (zips inside zips are fine) in
`data/drive/` and run `python -m pipeline.run all`. The folders that are read are listed in
`config/pipeline.toml` → `[paths] zips`.

To request new files: https://firms.modaps.eosdis.nasa.gov/download/ → create a request,
choose the sensor, the whole world (or an area) and the date range. FIRMS prepares the
file and offers it for download when ready (**VERIFY** the current delivery steps on the
page; large requests take a while). Older years (MODIS from Nov 2000, VIIRS S-NPP from
Jan 2012) are requested the same way.
