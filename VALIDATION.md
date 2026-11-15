# Validation results

Real results from the pipeline run of **15 Nov 2026** on the full FIRMS record used by the site
(whole world, 1 Nov 2000 – 13 Nov 2026: yearly country archives 2000–2022 plus archive downloads
from 13 Nov 2022; see docs/DATA_DOWNLOAD.md). Every number below can be recomputed from
`reports/validation_metrics.csv` and `reports/loyo_region_monthly.parquet`, which
`python -m pipeline.run harmonize` writes. They will change when the data changes.

## What was tested

**Leave-one-year-out (LOYO).** For each year in the overlap between a satellite and MODIS,
that year is removed, the transfer to MODIS is fitted on the other years, and the removed year
is predicted. The prediction is compared with what MODIS (Terra + Aqua) actually saw.
So every number here is for data the model **did not see** while fitting.

- Unit of comparison: one 30° world block in one month ("block-month").
- Overlap used: S-NPP Feb 2012 – Oct 2026 (15 years), NOAA-20 Apr 2018 – Oct 2026 (9 years),
  NOAA-21 Mar 2023 – Oct 2026 (4 years). Terra → Terra+Aqua is tested on 2003–2011 (9 years);
  it is used only for the Terra-only months before Aqua (Nov 2000 – Jun 2002).
- Done separately for each satellite and for both metrics (hotspot count and active cell-days).

## Headline: hotspot counts, all blocks pooled

| Satellite → MODIS | Held-out block-months | Raw vs MODIS | After harmonization | Pearson r (after) | Mean abs. error per block-month, raw → after | Median error per block-month |
|---|---:|---:|---:|---:|---:|---:|
| VIIRS S-NPP | 9,020 | **+314%** | **+1.2%** | 0.994 | 20,490 → 500 | 11% |
| VIIRS NOAA-20 | 5,183 | **+324%** | **+1.1%** | 0.994 | 20,821 → 567 | 12% |
| VIIRS NOAA-21 | 2,221 | **+324%** | **+0.5%** | 0.991 | 20,577 → 709 | 15% |
| Terra → Terra + Aqua | 4,360 | −67% | −0.3% | 0.997 | 6,273 → 553 | 8.5% |

Raw VIIRS reports about **4.1–4.2×** as many hotspots as MODIS for the same fires (375 m pixels
against 1 km). After harmonization the held-out totals agree to within about one percent, and the
month-to-month pattern matches closely (r ≈ 0.99).

"After harmonization" uses, for each block, the method the pipeline selected for it (lowest
held-out mean absolute error). "Median error" is the median of |predicted − MODIS| / MODIS over
block-months where MODIS saw fire.

## Second metric: active cell-days

Counts each 0.05° cell once per day, however many pixels fired in it. It is less sensitive
to pixel size by design, so the raw gap is smaller.

| Satellite → MODIS | Raw vs MODIS | After harmonization | Pearson r (after) |
|---|---:|---:|---:|
| VIIRS S-NPP | +178% | +0.2% | 0.994 |
| VIIRS NOAA-20 | +192% | +0.2% | 0.995 |
| VIIRS NOAA-21 | +189% | 0.0% | 0.991 |
| Terra → Terra + Aqua | −64% | −0.6% | 0.997 |

## Which method won

Three methods compete in every block (see METHODS.md §4). Number of blocks where each
was selected (hotspot counts):

| Satellite | Quantile mapping | Ratio | Theil–Sen |
|---|---:|---:|---:|
| S-NPP | 29 | 28 | 12 |
| NOAA-20 | 34 | 23 | 13 |
| NOAA-21 | 28 | 24 | 18 |
| Terra | 25 | 20 | 8 |

No single method is best everywhere, which is why the choice is made per block from the
held-out errors and not fixed in advance.

## What the totals look like

Whole world, harmonized series against raw MODIS (Terra + Aqua) in the same months:

| | MODIS-equivalent (harmonized) | Raw MODIS | Difference |
|---|---:|---:|---:|
| 2003–2011 (observed MODIS era) | identical | | 0.0% (the series *is* MODIS here) |
| **2012–2025 (VIIRS era)** | **56,522,991** | **56,588,707** | **−0.12%** |
| 2012 | 4,518,135 | 4,589,409 | −1.6% |
| 2017 | 4,031,145 | 4,107,622 | −1.9% |
| 2020 | 4,181,484 | 4,055,050 | +3.1% |
| 2023 | 4,274,056 | 4,246,532 | +0.6% |
| 2024 | 4,216,307 | 4,425,017 | −4.7% |
| 2025 | 3,528,309 | 3,334,703 | +5.8% |

This table is **not** held out (the final series uses all years), so it is shown only to give a
sense of scale. Over 14 years the totals match to 0.1%; single years differ by up to about 6%.
Before mid-2002 only Terra flew, so raw MODIS is much lower than the harmonized (Terra-scaled)
value there; those months are marked "Terra only, scaled" on the site.

## Honest caveats on these numbers

- **Single block-months are much less exact than totals.** The median error for one block in
  one month is about **8–15%** depending on the satellite (larger for NOAA-21, which has the
  fewest years to learn from). Totals over many months or a large area are far closer.
- **Small areas carry larger errors.** The site's uncertainty band widens for small counts, but
  it is calibrated on block and tile errors, not on every possible shape. (The 4-year build
  measured −23% for a box over Quebec in 2023; **VERIFY**: not recomputed on this build.)
- **Not yet recomputed on this build** (**VERIFY** before quoting): the bias for extreme
  months (≥ 3× usual activity) and the share of block-months whose observed MODIS value falls
  inside the uncertainty band. On the 4-year build these were +0.6% and 94.5%.
- **MODIS orbital drift.** Terra and Aqua drifted to different overpass times in their last
  years, which changes what MODIS sees. The overlap includes those years; set `overlap_end`
  in `config/pipeline.toml` to fit on earlier years only and compare these tables.
