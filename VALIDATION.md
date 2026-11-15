# Validation results

Real results from the pipeline run of **14 Nov 2026** on the project's FIRMS archive downloads
(whole world, 13 Nov 2022 – 13 Nov 2026). Every number below can be recomputed from
`reports/validation_metrics.csv` and `reports/loyo_region_monthly.parquet`, which
`python -m pipeline.run all` writes. They will change when the data changes.

## What was tested

**Leave-one-year-out (LOYO).** For each year in the MODIS–VIIRS overlap, that year is
removed, the VIIRS→MODIS transfer is fitted on the other years, and the removed year is
predicted. The prediction is compared with what MODIS (Terra + Aqua) actually saw.
So every number here is for data the model **did not see** while fitting.

- Unit of comparison: one 30° world block in one month ("block-month").
- 70 world blocks have fire data, with 47 overlap months (Dec 2022 – Oct 2026).
- Done separately for each VIIRS satellite and for both metrics (hotspot count and
  active cell-days).

## Headline: hotspot counts, all blocks pooled

| VIIRS satellite | Held-out block-months | Raw VIIRS vs MODIS | After harmonization | Pearson r (after) | Mean abs. error per block-month, raw → after |
|---|---:|---:|---:|---:|---:|
| S-NPP | 2,344 | **+331%** | **+0.3%** | 0.983 | 21,086 → 829 |
| NOAA-20 | 2,333 | **+339%** | **+0.2%** | 0.990 | 21,727 → 728 |
| NOAA-21 | 2,221 | **+324%** | **+0.5%** | 0.991 | 20,577 → 709 |

Raw VIIRS reports about **4.3×** as many hotspots as MODIS for the same fires (375 m pixels
against 1 km). After harmonization the totals agree to within half a percent, and the
month-to-month pattern matches closely (r ≈ 0.98–0.99).

"After harmonization" uses, for each block, the method the pipeline selected for it (lowest
held-out mean absolute error).

## Second metric: active cell-days

Counts each 0.05° cell once per day, however many pixels fired in it. It is less sensitive
to pixel size by design, so the raw gap is smaller.

| VIIRS satellite | Raw vs MODIS | After harmonization | Pearson r (after) |
|---|---:|---:|---:|
| S-NPP | +182% | 0.0% | 0.984 |
| NOAA-20 | +196% | −0.1% | 0.990 |
| NOAA-21 | +189% | 0.0% | 0.991 |

## Which method won

Three methods compete in every block (see METHODS.md §4). Number of blocks where each
was selected (hotspot counts):

| Satellite | Quantile mapping | Ratio | Theil–Sen |
|---|---:|---:|---:|
| S-NPP | 37 | 19 | 13 |
| NOAA-20 | 31 | 20 | 19 |
| NOAA-21 | 28 | 24 | 18 |

No single method is best everywhere, which is why the choice is made per block from the
held-out errors and not fixed in advance.

## What the totals look like

| | MODIS-equivalent (harmonized) | Raw MODIS | Difference |
|---|---:|---:|---:|
| Whole world, Nov 2022 – Nov 2026 | 15,216,275 | 15,204,253 | +0.08% |
| 2023 | 4,181,736 | 4,246,532 | −1.5% |
| 2024 | 4,099,116 | 4,425,017 | −7.4% |
| 2025 | 3,458,613 | 3,334,703 | +3.7% |

This table compares the final series with MODIS over the same months. It is **not** held
out (the final series uses all years), so it is shown only to give a sense of scale.
Single years can differ by several percent even though the four-year total matches.

## Honest caveats on these numbers

- **Single block-months are much less exact than totals.** The median error for one
  block in one month is about **15–16%**. Totals over many months or a large area are
  far closer.
- **Small areas carry larger errors.** Example: for a 15° × 9° box over Quebec in 2023,
  the harmonized total is 24,234 against 31,496 seen by MODIS (**−23%**), even though the
  whole 30° block that contains it was well within its band. The site's uncertainty band
  widens for small counts, but it is calibrated on block and tile errors, not on every
  possible shape.
- **Extreme months are not systematically under-predicted at block scale:** across 163
  held-out block-months that had at least 3× their usual activity, the bias was +0.6%.
- **The uncertainty band** (5th–95th percentile of held-out errors) contains the observed
  MODIS value in **94.5%** of 1,894 complete block-months. This check is in-sample, so the
  real coverage on new data is probably a little lower.
- **Only four years of overlap.** Leave-one-year-out with 4 years is a small test. The method
  is built for the full 2000–today record (see METHODS.md), where the overlap is
  2012 onwards and the test is much stronger.
