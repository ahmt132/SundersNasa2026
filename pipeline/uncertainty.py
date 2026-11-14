"""Uncertainty bands from leave-one-year-out validation residuals.

Residual = log((observed MODIS + 1) / (predicted + 1)), collected at two spatial
scales (calibration tile and whole region) and binned by the size of the predicted
value. Relative error shrinks as counts grow, so a small user selection gets a wider
band than a whole region. The band is the empirical 5th-95th percentile of the
residuals in the matching bin.

Lookup order when a bin has fewer than MIN_N residuals:
  (region, bin) -> (all regions, bin) -> the same two for each smaller-count bin in turn
  -> (region, all bins) -> (all regions, all bins)
Smaller-count bins have larger relative error, so falling back to them widens the band.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

BIN_EDGES = np.array([0, 1, 3, 10, 30, 100, 300, 1000, 3000, 10000, 30000, 100000, np.inf])
MIN_N = 30
QUANTILES = (0.05, 0.25, 0.50, 0.75, 0.95)
ALL = "*"


def bin_index(values: np.ndarray) -> np.ndarray:
    return np.clip(np.digitize(values, BIN_EDGES) - 1, 0, len(BIN_EDGES) - 2)


def build_table(residuals: pd.DataFrame) -> pd.DataFrame:
    """residuals: columns predictor, metric, region, pred, obs (one row per validated sample)."""
    cols = ["predictor", "metric", "region", "bin", "n"] + [f"q{int(q * 100):02d}" for q in QUANTILES]
    if residuals.empty:
        return pd.DataFrame(columns=cols)
    df = residuals[np.isfinite(residuals["pred"]) & np.isfinite(residuals["obs"])].copy()
    df["resid"] = np.log((df["obs"] + 1.0) / (df["pred"] + 1.0))
    df["bin"] = bin_index(df["pred"].to_numpy())

    frames = []
    for region_all, bin_all in ((False, False), (True, False), (False, True), (True, True)):
        d = df.copy()
        if region_all:
            d["region"] = ALL
        if bin_all:
            d["bin"] = -1
        g = d.groupby(["predictor", "metric", "region", "bin"])["resid"]
        out = g.quantile(list(QUANTILES)).unstack()
        out.columns = [f"q{int(q * 100):02d}" for q in QUANTILES]
        out.insert(0, "n", g.size())
        frames.append(out.reset_index())
    return pd.concat(frames, ignore_index=True)[cols]


class BandLookup:
    def __init__(self, table: pd.DataFrame):
        self._rows = {
            (r.predictor, r.metric, r.region, int(r.bin)): (int(r.n), float(r.q05), float(r.q95))
            for r in table.itertuples()
        }

    def band(self, predictor: str, metric: str, region: str, values) -> tuple[np.ndarray, np.ndarray]:
        """5-95 % band around harmonized values. NaN where no validation residuals exist."""
        values = np.atleast_1d(np.asarray(values, dtype=float))
        lo = np.full(values.shape, np.nan)
        hi = np.full(values.shape, np.nan)
        finite = np.isfinite(values)
        bins = np.where(finite, bin_index(np.where(finite, values, 0.0)), -2)
        for b in np.unique(bins[finite]):
            hit = None
            keys = []
            for step in range(int(b), -1, -1):  # same bin first, then smaller-count bins (wider, so conservative)
                keys += [(predictor, metric, region, step), (predictor, metric, ALL, step)]
            keys += [(predictor, metric, region, -1), (predictor, metric, ALL, -1)]
            for key in keys:
                row = self._rows.get(key)
                if row and row[0] >= MIN_N:
                    hit = row
                    break
            if hit is None:
                continue
            sel = bins == b
            v = values[sel]
            lo[sel] = np.minimum(v, np.clip((v + 1.0) * np.exp(hit[1]) - 1.0, 0.0, None))
            hi[sel] = np.maximum(v, (v + 1.0) * np.exp(hit[2]) - 1.0)
        return lo, hi
