# Getting the data

History comes from the **FIRMS Archive Download** tool (bulk CSV). Only the last days come
from the FIRMS API. Facts below were read from the FIRMS pages on 2026-11-12; items I
could not confirm from the page text are marked **VERIFY**.

## 0. Fastest path: yearly country files (no login)

FIRMS publishes one CSV per country, sensor and year (linked from the archive page as
"Download yearly summary by country"). They are standard-processing data in the same
format as archive downloads. Probed 2026-11-12: MODIS 2000-2025, VIIRS S-NPP 2012-2025,
VIIRS NOAA-20 2018-2025. The current year (2026) and NOAA-21 are not published this way.

```
.venv\Scripts\python -m pipeline.run fetch-country --regions turkiye_med
.venv\Scripts\python -m pipeline.run fetch-country            # all four regions, several GB of transfer
```

The downloader streams each file and keeps only rows inside the region's box, so disk
use is small even though the transfer is not (Türkiye ~0.1 GB, California ~1.5 GB,
Northern Australia ~1.8 GB, Amazon ~3 GB with all three sensors). Finished files are
skipped on re-run. Limitation: files are per country, so parts of a box that lie in a
neighbouring country stay empty unless you add that country to `firms_countries`.

The FIRMS server often drops long transfers, and a dropped transfer simply ends early.
The downloader therefore resumes from the last complete line and accepts a file only
when the byte count equals the size the server reports. To re-check files already on
disk (it compares the end of each file with the end of the server's copy):

```
.venv\Scripts\python -m pipeline.run verify-country
```

Delete any file it reports as INCOMPLETE and run `fetch-country` again.

Use sections 1-2 below to add 2026 and the most recent days.

## 1. Archive download (once per region)

Page: https://firms.modaps.eosdis.nasa.gov/download/

1. Sign in with Earthdata Login, or use the emailed-code option on the page.
2. Create a new request. **VERIFY** the exact button and field labels on the form.
3. Area of interest: choose the custom region / bounding-box option and enter the box
   from the table below. **VERIFY** the order the form asks for; the table gives
   west, south, east, north.
4. Fire data source: make one request per source (or tick several if the form allows):
   - MODIS Collection 6.1 - from 2000-11-01
   - VIIRS S-NPP 375m - 2012-01-20 to 2026-11-02 (FIRMS lists this as the end of S-NPP data)
   - VIIRS NOAA-20 375m - from 2018-04-01
   - VIIRS NOAA-21 375m - from 2023-03-01
5. Date range: the source's first day to today.
6. Format: **.csv**
7. Submit. FIRMS emails a download link when the request is processed.
8. Unzip and put every `.csv` into `data/raw/<region_id>/`. File names do not matter:
   the pipeline reads the sensor from the columns and the processing level from the
   `version` column. If a VIIRS file has no usable `satellite` column, keep `SNPP`,
   `NOAA20` or `NOAA21` (or FIRMS's own `SV-`, `J1V-`, `J2V-` codes) in its name.

| Region | `region_id` (folder name) | West | South | East | North |
|---|---|---|---|---|---|
| Türkiye Mediterranean coast (Antalya-Muğla) | `turkiye_med` | 27.0 | 35.8 | 33.0 | 37.9 |
| Brazilian Amazon (Pará / Rondônia) | `amazon_para_rondonia` | -67.0 | -14.0 | -46.0 | 3.0 |
| Northern Australia | `northern_australia` | 120.0 | -20.0 | 146.0 | -10.5 |
| California | `california` | -124.5 | 32.5 | -114.1 | 42.1 |

These boxes are my choice of demo extent, defined in `config/pipeline.toml`. The Amazon
and Northern Australia VIIRS requests are large; if FIRMS rejects one for size, split
the date range into several requests. Overlapping files are safe - duplicates are
removed.

Start with `turkiye_med` (small, and it carries the demo story). The pipeline runs on
whichever regions have files.

## 2. Recent days (FIRMS area API)

The archive tool serves data older than the last 7 days. The API fills the gap.

Get a free key at https://firms.modaps.eosdis.nasa.gov/api/map_key/ , then in PowerShell:

```
$env:FIRMS_MAP_KEY = "<your key>"
.venv\Scripts\python -m pipeline.run fetch-nrt --days 14
```

The API allows at most 5 days per request; the fetcher splits the range for you and
writes `api_<SOURCE>_<start>_<end>.csv` into each region folder.

## 3. Run

```
.venv\Scripts\python -m pipeline.run all
```

Outputs: `data/processed/` (Parquet), `reports/validation_metrics.csv`,
`reports/validation_<region>.png`.

## Adding a region

Add one table to `config/pipeline.toml`, create `data/raw/<id>/`, drop the CSVs in:

```toml
[regions.my_region]
name = "My region"
bbox = [west, south, east, north]
```
