# Getting the data

## What the live site uses (worldwide, 1 Nov 2000 – 13 Nov 2026)

Two kinds of NASA FIRMS files, both for the whole world. Nothing else is used.

### 1. Yearly country archives, 2000–2022 → `data/drive_part1/`

FIRMS "yearly summary by country" zips, one per sensor and year, each holding one CSV per
country (standard processing). Downloaded from https://firms.modaps.eosdis.nasa.gov/country/ ;
the files themselves are at
`https://firms.modaps.eosdis.nasa.gov/data/country/zips/<sensor>_<year>_all_countries.zip`
(no login; this address was read from the downloaded files' browser record on 15 Nov 2026).

| File name | Years used | First day in the data |
|---|---|---|
| `modis_<year>_all_countries.zip` | 2000–2022 | Terra 1 Nov 2000, Aqua 4 Jul 2002 |
| `viirs-snpp_<year>_all_countries.zip` | 2012–2022 | 20 Jan 2012 |
| `viirs-jpss1_<year>_all_countries.zip` (NOAA-20) | 2018–2022 | 1 Apr 2018 |

Points over open ocean that belong to no country are not in these files; the vegetation-fire
filter (type 0) removes offshore detections anyway. The 2022 files overlap the archive
downloads below from 13 Nov 2022; those rows are removed as exact duplicates in the ingest.

### 2. Archive downloads, 13 Nov 2022 – 13 Nov 2026 → `data/drive/`

FIRMS **Archive Download** files for the whole world, one request per sensor, kept in the
team's Google Drive folder "Nasa SpaceApps 2026":

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
