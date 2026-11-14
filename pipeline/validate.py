"""Leave-one-year-out validation, method selection, and the per-region validation figure."""
from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .config import Config
from .transfer import fit_hierarchy, predict

ALL = "*"


def metrics(obs: np.ndarray, pred: np.ndarray) -> dict:
    ok = np.isfinite(obs) & np.isfinite(pred)
    obs, pred = obs[ok], pred[ok]
    out = {"n_months": int(obs.size)}
    if obs.size == 0:
        return out | {"bias": np.nan, "rel_bias": np.nan, "mae": np.nan, "pearson_r": np.nan, "spearman_rho": np.nan}

    def corr(a, b):
        if a.size < 3 or np.ptp(a) == 0 or np.ptp(b) == 0:
            return np.nan
        return float(np.corrcoef(a, b)[0, 1])

    out["bias"] = float(np.mean(pred - obs))
    out["rel_bias"] = float(pred.sum() / obs.sum() - 1.0) if obs.sum() > 0 else np.nan
    out["mae"] = float(np.mean(np.abs(pred - obs)))
    out["pearson_r"] = corr(obs, pred)
    out["spearman_rho"] = corr(pd.Series(obs).rank().to_numpy(), pd.Series(pred).rank().to_numpy())
    return out


def loyo(pairs: pd.DataFrame, cfg: Config) -> pd.DataFrame:
    """Hold out each calendar year in turn; predict it from all the other years."""
    folds = []
    for year in sorted(pairs["year"].unique()):
        train = pairs[pairs["year"] != year]
        test = pairs[pairs["year"] == year].copy()
        for method in cfg.methods:
            model = fit_hierarchy(train, method, cfg.min_pairs, cfg.max_fit_points, cfg.seed)
            test[f"pred_{method}"], _ = predict(model, test)
        folds.append(test)
    return pd.concat(folds, ignore_index=True)


def region_monthly(loyo_df: pd.DataFrame, cfg: Config) -> pd.DataFrame:
    """Sum tile-level held-out predictions to region x month. A tile the method could not
    predict makes the whole region-month NaN for that method (min_count), never a silent 0."""
    cols = ["x", "y"] + [f"pred_{m}" for m in cfg.methods]
    grouped = loyo_df.groupby(["region", "month"])[cols]
    out = grouped.sum(min_count=1)
    for m in cfg.methods:
        incomplete = loyo_df[f"pred_{m}"].isna().groupby([loyo_df["region"], loyo_df["month"]]).any()
        out.loc[incomplete[incomplete].index, f"pred_{m}"] = np.nan
    return out.reset_index()


def score(rm: pd.DataFrame, cfg: Config, predictor: str, metric: str) -> pd.DataFrame:
    """Validation metrics per region (and '*' = all regions pooled) for each method and for raw data."""
    rows = []
    scopes = [(r, g) for r, g in rm.groupby("region")] + [(ALL, rm)]
    for region, g in scopes:
        obs = g["y"].to_numpy(float)
        rows.append(
            {"predictor": predictor, "metric": metric, "region": region, "method": "raw"}
            | metrics(obs, g["x"].to_numpy(float))
        )
        for m in cfg.methods:
            rows.append(
                {"predictor": predictor, "metric": metric, "region": region, "method": m}
                | metrics(obs, g[f"pred_{m}"].to_numpy(float))
            )
    return pd.DataFrame(rows)


def select(scores: pd.DataFrame, cfg: Config) -> dict[str, str]:
    """Lowest leave-one-year-out MAE wins, per region. Ties go to the smaller |bias|."""
    chosen = {}
    cand = scores[scores["method"].isin(cfg.methods) & scores["mae"].notna()].copy()
    cand["abs_bias"] = cand["bias"].abs()
    for region, g in cand.groupby("region"):
        chosen[region] = g.sort_values(["mae", "abs_bias"]).iloc[0]["method"]
    return chosen


def figure(
    rm: pd.DataFrame,
    method: str,
    stats_raw: dict,
    stats_h: dict,
    region_name: str,
    predictor_label: str,
    out_path,
) -> None:
    """One figure per region: raw MODIS vs raw VIIRS vs harmonized (held-out predictions)."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    INK, MUTED, GRID = "#1a1a1a", "#5f5f5f", "#dddddd"
    C_MODIS, C_VIIRS, C_HARM = "#0072B2", "#7a7a7a", "#D55E00"  # Okabe-Ito blue / grey / vermillion

    rm = rm.sort_values("month")
    full = pd.date_range(rm["month"].min(), rm["month"].max(), freq="MS")
    ts = rm.set_index("month").reindex(full)
    pred = f"pred_{method}"

    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9, "axes.edgecolor": MUTED,
                         "axes.labelcolor": INK, "xtick.color": MUTED, "ytick.color": MUTED})
    fig = plt.figure(figsize=(11, 7.4), dpi=150)
    gs = fig.add_gridspec(2, 2, height_ratios=[1.15, 1], hspace=0.42, wspace=0.22,
                          left=0.07, right=0.98, top=0.90, bottom=0.11)

    ax = fig.add_subplot(gs[0, :])
    ax.plot(ts.index, ts["x"], color=C_VIIRS, lw=1.2, ls=":", label=f"Raw {predictor_label}")
    ax.plot(ts.index, ts["y"], color=C_MODIS, lw=2.0, ls="-", label="Raw MODIS (Terra + Aqua)")
    ax.plot(ts.index, ts[pred], color=C_HARM, lw=1.6, ls="--",
            label=f"Harmonized, held-out year ({method})")
    ax.set_yscale("symlog", linthresh=1)
    ax.set_ylabel("Hotspots per month (count, log scale)")
    ax.set_xlabel("Month (UTC acquisition date)")
    ax.grid(True, color=GRID, lw=0.6)
    ax.set_axisbelow(True)
    ax.legend(loc="upper left", ncol=3, frameon=False, fontsize=8.5)
    ax.set_title("Monthly series over the sensor overlap", loc="left", fontsize=10, color=INK)

    lim = max(1.0, float(np.nanmax([rm["x"].max(), rm["y"].max(), rm[pred].max()]))) * 1.5
    panels = (
        (gs[1, 0], "x", f"Raw {predictor_label} (hotspots / month)", C_VIIRS, "s", stats_raw, "Before: raw VIIRS vs MODIS"),
        (gs[1, 1], pred, "Harmonized, held-out year (MODIS-equivalent hotspots / month)", C_HARM, "o", stats_h,
         "After: harmonized vs MODIS"),
    )
    for spec, col, xlabel, color, marker, st, title in panels:
        a = fig.add_subplot(spec)
        a.plot([0, lim], [0, lim], color=INK, lw=0.8, label="1:1 line")
        a.scatter(rm[col], rm["y"], s=14, color=color, marker=marker, alpha=0.75, linewidths=0)
        a.set_xscale("symlog", linthresh=1)
        a.set_yscale("symlog", linthresh=1)
        a.set_xlim(0, lim)
        a.set_ylim(0, lim)
        a.set_xlabel(xlabel)
        a.set_ylabel("Raw MODIS (hotspots / month)")
        a.grid(True, color=GRID, lw=0.6)
        a.set_axisbelow(True)
        a.set_title(title, loc="left", fontsize=10, color=INK)
        a.legend(loc="lower right", frameon=False, fontsize=8)
        a.text(
            0.03, 0.96,
            f"n = {st['n_months']} months\nbias = {st['bias']:+.1f}  ({st['rel_bias']:+.1%} of total)\n"
            f"MAE = {st['mae']:.1f}\nPearson r = {st['pearson_r']:.3f}\nSpearman rho = {st['spearman_rho']:.3f}",
            transform=a.transAxes, ha="left", va="top", fontsize=8.5, color=INK,
            family="DejaVu Sans Mono",
        )

    fig.suptitle(f"{region_name} - harmonization validation (leave-one-year-out)",
                 x=0.07, ha="left", fontsize=12, color=INK)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    fig.text(0.07, 0.025,
             "Data: NASA FIRMS - MODIS Collection 6.1 (MCD14ML / MCD14DL) and VIIRS 375 m active fire. "
             f"Months with no detection by either sensor are not plotted. Generated {stamp}.",
             fontsize=7.5, color=MUTED)
    fig.savefig(out_path)
    plt.close(fig)
