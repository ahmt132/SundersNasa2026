"""Transfer functions: predictor monthly value -> MODIS (Terra+Aqua) equivalent.

A sample is one calibration tile in one month: x = predictor value, y = MODIS value.
The same engine serves VIIRS -> MODIS and Terra -> Terra+Aqua, for both metrics
(hotspot counts and active cell-days).

Methods
  theilsen  robust log-log line  log1p(y) = a + b*log1p(x)  (Theil-Sen slope, median
            intercept), then one multiplicative factor c so that training totals match.
            The factor is needed because a line fitted to log values predicts medians,
            and sums of medians run low.
  qmap      empirical quantile mapping: the k-th smallest x maps to the k-th smallest y.
  ratio     y = r * x with r = sum(y) / sum(x). Deliberately simple baseline.

All methods return 0 for x = 0, so a tile-month with no predictor detections stays empty.

Hierarchy (finest first). A group's fit is accepted only if it has at least
`min_pairs` samples where both sensors are > 0; otherwise the next level is used.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

LEVELS: tuple[tuple[str, ...], ...] = (
    ("region", "tx", "ty", "moy"),
    ("region", "moy"),
    ("region",),
    ("moy",),
    (),
)
LEVEL_NAMES = ("tile_x_month", "region_x_month", "region", "global_x_month", "global")


@dataclass
class HierModel:
    method: str
    levels: list[dict]  # one dict per LEVELS entry: group key tuple -> fitted parameters


# ---------------------------------------------------------------- single-group fits


def _curve_theilsen(x: np.ndarray, params: tuple) -> np.ndarray:
    a, b, c = params
    return c * np.clip(np.expm1(a + b * np.log1p(x)), 0.0, None)


def _fit_theilsen(x: np.ndarray, y: np.ndarray, max_points: int, rng: np.random.Generator):
    lx, ly = np.log1p(x), np.log1p(y)
    if lx.size > max_points:
        pick = rng.choice(lx.size, max_points, replace=False)
        sx, sy = lx[pick], ly[pick]
    else:
        sx, sy = lx, ly
    if np.unique(sx).size < 3:
        return None
    i, j = np.triu_indices(sx.size, 1)
    dx = sx[j] - sx[i]
    ok = dx != 0
    slope = float(np.median((sy[j] - sy[i])[ok] / dx[ok]))
    if not (np.isfinite(slope) and slope > 0):
        return None
    intercept = float(np.median(sy - slope * sx))
    base = _curve_theilsen(x, (intercept, slope, 1.0))
    base[x == 0] = 0.0
    total = base.sum()
    if not (np.isfinite(total) and total > 0):
        return None
    return (intercept, slope, float(y.sum() / total))


def _curve_qmap(x: np.ndarray, params: tuple) -> np.ndarray:
    xs, ys = params
    top = ys[-1] / xs[-1]
    return np.where(x <= xs[-1], np.interp(x, xs, ys), x * top)


def _fit_qmap(x: np.ndarray, y: np.ndarray):
    if x.size > 200:
        q = np.linspace(0.0, 1.0, 101)
        xs, ys = np.quantile(x, q), np.quantile(y, q)
    else:
        xs, ys = np.sort(x), np.sort(y)
    xs = np.concatenate([[0.0], xs])
    ys = np.concatenate([[0.0], ys])
    # np.interp needs strictly increasing x: average y over tied x values.
    ux, inverse = np.unique(xs, return_inverse=True)
    uy = np.bincount(inverse, weights=ys) / np.bincount(inverse)
    uy[0] = 0.0
    if ux.size < 3 or ux[-1] <= 0:
        return None
    return (ux, np.maximum.accumulate(uy))


def _fit_ratio(x: np.ndarray, y: np.ndarray):
    sx = x.sum()
    if sx <= 0:
        return None
    return (float(y.sum() / sx),)


def _curve(method: str, x: np.ndarray, params: tuple) -> np.ndarray:
    if method == "theilsen":
        out = _curve_theilsen(x, params)
    elif method == "qmap":
        out = _curve_qmap(x, params)
    elif method == "ratio":
        out = params[0] * x
    else:
        raise ValueError(f"unknown method {method}")
    out = np.asarray(out, dtype=float)
    out[x == 0] = 0.0
    return out


def _as_key(key) -> tuple:
    return key if isinstance(key, tuple) else (key,)


def _groups(df: pd.DataFrame, keys: tuple[str, ...]) -> dict:
    if not keys:
        return {(): np.arange(len(df))}
    return df.groupby(list(keys), sort=False).indices


# ---------------------------------------------------------------- hierarchy


def fit_hierarchy(
    pairs: pd.DataFrame, method: str, min_pairs: int, max_points: int, seed: int
) -> HierModel:
    """pairs needs columns region, tx, ty, moy, x, y."""
    rng = np.random.default_rng(seed)
    x = pairs["x"].to_numpy(float)
    y = pairs["y"].to_numpy(float)
    levels = []
    for keys in LEVELS:
        fitted = {}
        for key, idx in _groups(pairs, keys).items():
            xi, yi = x[idx], y[idx]
            if np.count_nonzero((xi > 0) & (yi > 0)) < min_pairs:
                continue
            if method == "theilsen":
                params = _fit_theilsen(xi, yi, max_points, rng)
            elif method == "qmap":
                params = _fit_qmap(xi, yi)
            elif method == "ratio":
                params = _fit_ratio(xi, yi)
            else:
                raise ValueError(f"unknown method {method}")
            if params is not None:
                fitted[_as_key(key)] = params
        levels.append(fitted)
    return HierModel(method, levels)


def predict(model: HierModel, df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """Return (prediction, level index used). Rows no level can serve stay NaN / -1."""
    x = df["x"].to_numpy(float)
    pred = np.full(len(df), np.nan)
    level = np.full(len(df), -1, dtype=np.int8)
    for li, (keys, fitted) in enumerate(zip(LEVELS, model.levels)):
        if not fitted:
            continue
        todo = np.flatnonzero(np.isnan(pred))
        if todo.size == 0:
            break
        sub = df.iloc[todo]
        for key, pos in _groups(sub, keys).items():
            params = fitted.get(_as_key(key))
            if params is None:
                continue
            rows = todo[pos]
            pred[rows] = _curve(model.method, x[rows], params)
            level[rows] = li
    return pred, level
