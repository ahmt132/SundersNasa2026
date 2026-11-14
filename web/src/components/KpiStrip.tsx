import type { Kpis } from "../api";
import { MONTHS_LONG, fmt, monthLabel } from "../lib";

function ordinal(n: number): string {
  const r = Math.round(n);
  const s = ["th", "st", "nd", "rd"];
  const v = r % 100;
  return `${r}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

function Tile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="kpi">
      <dt>{label}</dt>
      <dd className="kpi-value">{value}</dd>
      <dd className="kpi-detail">{detail}</dd>
    </div>
  );
}

export function KpiStrip({ kpis, unitShort, range }: { kpis: Kpis; unitShort: string; range: string }) {
  const lm = kpis.latest_month;
  const raw = kpis.totals;
  const viirs = raw.viirs_snpp_raw || raw.viirs_n20_raw || raw.viirs_n21_raw;
  return (
    <dl className="kpis" aria-label="Key figures for the selection">
      <Tile
        label={lm ? `${monthLabel(lm.month)} vs. its median` : "Latest month vs. median"}
        value={lm?.ratio_to_median != null ? `${lm.ratio_to_median.toFixed(lm.ratio_to_median < 10 ? 2 : 0)}×` : "–"}
        detail={
          lm
            ? lm.historical_median === 0
              ? `${fmt(lm.value)} ${unitShort}; the median of the other ${lm.n_other_years} years is 0`
              : `${fmt(lm.value)} against a median of ${fmt(lm.historical_median)} · ${lm.percentile_rank != null ? `${ordinal(lm.percentile_rank)} percentile of ${lm.n_other_years} other years` : "no other years"}`
            : "No complete month in this range"
        }
      />
      <Tile
        label="Peak fire month"
        value={kpis.peak_month ? MONTHS_LONG[kpis.peak_month.moy - 1] : "–"}
        detail={
          kpis.peak_month
            ? kpis.peak_month.basis === "median"
              ? `Highest monthly median: ${fmt(kpis.peak_month.value)} ${unitShort}`
              : `Highest monthly mean: ${fmt(kpis.peak_month.value)} ${unitShort} (every monthly median is 0 here)`
            : "No hotspots in any complete month of this range"
        }
      />
      <Tile
        label="Record year"
        value={kpis.record_year ? String(kpis.record_year.year) : "–"}
        detail={kpis.record_year ? `${fmt(kpis.record_year.value)} ${unitShort} · highest of ${kpis.record_year.n_complete_years} complete years` : "No complete calendar year in this range"}
      />
      <Tile
        label={`Total, ${range}`}
        value={fmt(raw.harmonized)}
        detail={`MODIS-equivalent ${unitShort}. Raw detections: MODIS ${fmt(raw.modis_raw)} · VIIRS ${fmt(viirs)}`}
      />
    </dl>
  );
}
