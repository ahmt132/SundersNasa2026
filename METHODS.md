# Methods

How MODIS and VIIRS active-fire hotspots are merged into one monthly series, and why
each choice was made. Every threshold named here is a line in `config/pipeline.toml`.

> **Status of validation numbers.** The pipeline has been run end to end only on
> synthetic test data (`tests/synthetic.py`). No real-data validation result is quoted
> in this file. Real numbers are written to `reports/validation_metrics.csv` and
> `reports/validation_<region>.png` when you run the pipeline on FIRMS downloads.

## 1. The problem

MODIS (Terra from Nov 2000, Aqua from Jul 2002) sees fires in 1 km pixels. VIIRS
(S-NPP from Jan 2012, later NOAA-20 and NOAA-21) sees them in 375 m pixels. For the same
fire activity VIIRS reports several times more hotspots, and the factor changes with
region and season. Plotting both on one axis shows a jump in 2012 that is an instrument
change, not a change in burning. The goal is one series in a single unit,
**MODIS-equivalent hotspots per month**, from 2000 to today, that can continue on VIIRS
alone when MODIS stops.

MODIS units were chosen as the common unit because MODIS is the only record covering
2000-2011; converting VIIRS down to MODIS loses detail but invents nothing.

## 2. Cleaning (`pipeline/ingest.py`)

| Rule | Why |
|---|---|
| MODIS confidence >= 30 | Drops the low-confidence class, which has the most false alarms. |
| VIIRS confidence nominal or high | Same reason; VIIRS uses three classes instead of a percentage. |
| Standard-processing `type` = 0 only (toggle `include_nonveg_types`) | Types 1, 2, 3 are volcanoes, static industrial sources and offshore flares. They are not burning vegetation. NRT rows have no type and are kept. |
| Standard processing (SP) beats near-real-time (NRT) | SP has better geolocation and quality control. For each satellite, NRT rows dated on or before the last SP day are dropped. |
| Exact duplicates removed | Overlapping downloads repeat rows. Key: satellite, date, time, lat/lon rounded to 4 decimals. |
| Rows outside the region bbox dropped | Lets you use a larger (e.g. country) download for a smaller region. |

SP and NRT are told apart by the `version` column (a letter suffix such as `NRT` means
near-real-time). MODIS and VIIRS files are told apart by their brightness column
(`brightness` vs `bright_ti4`). Counts dropped by each rule are saved in
`data/processed/ingest_report.json`.

## 3. Common unit (`pipeline/grid.py`)

- **Daily counts on a 0.1 degree grid**, per satellite. Both sensors land on identical cells.
- **Active cell-days on a 0.05 degree grid**: the number of (cell, day) pairs with at least
  one detection. Ten VIIRS pixels on one fire inside one cell on one day count once, as
  does one MODIS pixel. This metric is far less sensitive to pixel size than raw counts,
  so it is a cross-check: if the count calendar and the cell-day calendar disagree about
  a trend, the trend is probably an instrument effect.
- Months are calendar months of the UTC acquisition date.

## 4. Calibration (`pipeline/transfer.py`)

A **sample** is one 1 degree tile in one month: `x` = what the predictor saw, `y` = what MODIS
(Terra + Aqua) saw. Only months where the predictor and both MODIS satellites have a
complete month are used. Tile-months where both saw nothing are left out.

Three methods are fitted and compared:

1. **Theil-Sen log-log line.** `log(1+y) = a + b*log(1+x)`. The slope is the median of all
   pairwise slopes, so a few extreme months cannot bend it. A log-log line allows the
   VIIRS:MODIS ratio to change with fire activity. Because a line fitted to logs predicts
   medians, one factor is applied afterwards so that training totals match.
2. **Quantile mapping.** The k-th smallest VIIRS value maps to the k-th smallest MODIS
   value. No shape is assumed. Above the largest training value it continues with the
   top ratio.
3. **Ratio.** `y = r*x`. Included as a baseline: a complex method must beat it to be used.

All three return 0 for `x = 0`.

**Hierarchy.** A fit is trusted only if its group has at least `min_pairs` (8) samples
where both sensors saw fire. Each tile-month uses the finest level that qualifies:

`tile x month-of-year` -> `region x month-of-year` -> `region` -> `all regions x month-of-year` -> `all regions`

The level used is stored for every tile-month (`tile_weights`, column `level`).

**Harmonization weight.** For each tile-month, `weight = MODIS-equivalent / raw`. Every
hotspot in that tile and month carries the weight, so the harmonized value of any area is
the sum of the weights of the hotspots inside it. This is how the API answers arbitrary
polygons without refitting.

**Which VIIRS satellite.** One satellite at a time, in the order `viirs_priority`
(S-NPP, NOAA-20, NOAA-21), each with its own transfer. Adding satellites together would
create a step every time one launched. S-NPP has the longest overlap with MODIS. FIRMS
states that S-NPP no longer delivers new data (archive listed to 2 Nov 2026), so the
newest months come from NOAA-20 automatically.

## 5. Validation and method choice (`pipeline/validate.py`)

**Leave-one-year-out.** Each overlap year is removed in turn, the transfer is fitted on
the remaining years, and the removed year is predicted. Predictions are summed to
region x month and compared with observed MODIS. Reported per region, for each method and
for raw VIIRS: bias, bias as % of total, MAE, Pearson r, Spearman rho.

**Selection rule:** lowest held-out MAE per region; ties go to the smaller absolute bias.
MAE in counts was chosen because it is dominated by the fire season, which is what a
burning calendar is read for. The choice is made by the script, per region and metric,
and recorded in `data/processed/harmonized/meta.json`.

If a predictor has fewer than two overlap years it cannot be validated; the ratio method
is used and `validated: false` is recorded.

## 6. Terra-only era (Nov 2000 - Jun 2002)

Before Aqua, MODIS had one satellite and saw roughly half the overpasses. The same
engine learns `Terra -> Terra+Aqua` from 2003-2011 (both satellites healthy, before
VIIRS), with the same hierarchy and the same leave-one-year-out validation. Those months
are scaled up and flagged `terra_only`. July 2002 (Aqua data begins part-way through the
month) is treated the same way.

Assumption: the share of fires seen by the morning (Terra) vs afternoon (Aqua) overpass
in 2000-2002 was the same as in 2003-2011.

## 7. Final series (`pipeline/harmonize.py`)

| Period | Value | `era` |
|---|---|---|
| Aqua missing or incomplete | Terra scaled to Terra+Aqua units | `modis_terra_only` |
| Both MODIS satellites complete, before the first full VIIRS month | Observed MODIS, unchanged | `modis_observed` |
| From the first full VIIRS month (Feb 2012) | VIIRS converted to MODIS-equivalent | `viirs_transfer` |

From 2012 the series is **always** VIIRS-derived, including years when MODIS was still
flying. Switching instruments only once avoids a second seam when MODIS ends. Raw MODIS
is kept beside it for every month it exists, so the two can be compared.

Every month stores: raw MODIS, raw Terra, raw Aqua, raw VIIRS per satellite, the
harmonized value, a lower and upper bound, the source, the method, and flags
(`terra_only`, `partial`, `days_observed`).

**Partial months** (the current month, or a satellite's first month) hold only the days
observed. They are flagged, not extrapolated.

## 8. Uncertainty band (`pipeline/uncertainty.py`)

The band is the 5th-95th percentile of held-out validation errors, expressed as a ratio
(observed MODIS / predicted). Errors are collected at tile scale and region scale and
grouped by the size of the predicted count, because relative error is large for a
handful of hotspots and small for thousands. A selection with few hotspots therefore
gets a wider band than a whole region.

What the band covers: error in converting one sensor to the other. What it does not
cover: fires neither sensor saw (cloud, smoke, timing), or error in observed-MODIS months
(shown with zero width).

## 9. Known gaps in this method

- The transfer assumes the VIIRS:MODIS relationship learned in the overlap holds
  afterwards. Terra and Aqua have drifted to later/earlier overpass times in recent
  years, which changes what MODIS sees. Set `overlap_end` (e.g. `"2021-12"`) to fit on
  pre-drift years only; compare the validation tables both ways before choosing.
- Sensor outages inside a month are not corrected. VERIFY against FIRMS notices before
  interpreting a single low month (for example the Terra outage in mid-2001 and the Aqua
  outage in Aug 2020).
- A tile-month where MODIS saw fire and VIIRS saw none contributes 0 after 2012.
- Calibration tiles are 1 degree; a user polygon much smaller than a tile inherits the
  tile's weight.

## 10. Reproducing

```
python -m pipeline.run all        # ingest + grid + harmonize, writes reports/
python -m pytest tests            # end-to-end check on synthetic data
```
