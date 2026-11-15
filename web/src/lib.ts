// Shared tokens, formatting, colour scales and small statistics used by every chart.
import { interpolateInferno, interpolateLab, piecewise } from "d3";
import type { MonthRow, RegionInfo, Selection } from "./api";

// ---- design tokens (mirrored in styles.css; charts need them as literals so SVG exports are self-contained)
export const T = {
  bg: "#1a1b1d",
  surface: "#222326",
  raised: "#2e3034",
  hairline: "#3a3d42",
  ink: "#e8e6e3",
  ink2: "#aeaca7",
  ink3: "#85837f",
  accent: "#d9641f", // harmonized series and the primary action - nothing else
  modis: "#3f97d1",
  viirs: "#b8669a",
  zero: "#33363b", // a month with data and zero detections
  sans: "'IBM Plex Sans', system-ui, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, monospace",
};
// Categorical trio validated with the dataviz palette validator on surface #222326 (dark mode):
// lightness band, chroma floor, CVD separation (worst dE 8.7 deutan), contrast >= 3:1 all pass.

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];

// ---- formatting
const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
export function fmt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "–";
  return Math.abs(v) < 10 && !Number.isInteger(v) ? nf1.format(v) : nf0.format(v);
}
/** Short numbers for legends where space is tight: 950, 1.2k, 12k, 203k, 1.4M. */
export function fmtCompact(v: number): string {
  const a = Math.abs(v);
  const short = (x: number, unit: string) => `${x < 10 ? nf1.format(x) : nf0.format(x)}${unit}`;
  if (a >= 1e6) return short(v / 1e6, "M");
  if (a >= 1e3) return short(v / 1e3, "k");
  return fmt(v);
}
export function fmtAxis(v: number): string {
  if (Math.abs(v) >= 1e6) return `${nf1.format(v / 1e6)}M`;
  if (Math.abs(v) >= 1e4) return `${nf1.format(v / 1e3)}K`;
  return nf0.format(v);
}
export const fmtPct = (v: number) => `${v > 0 ? "+" : ""}${nf0.format(v)}%`;
export const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`;

export const SAT_LABEL: Record<string, string> = {
  modis: "MODIS (Terra + Aqua)",
  terra: "MODIS Terra",
  viirs_snpp: "VIIRS S-NPP",
  viirs_n20: "VIIRS NOAA-20",
  viirs_n21: "VIIRS NOAA-21",
};

export function eraLabel(m: MonthRow): string {
  if (m.era === "modis_terra_only") return "Terra-only era · scaled to Terra + Aqua units";
  if (m.era === "modis_observed") return "MODIS era · observed, no adjustment";
  if (m.era === "viirs_transfer") return `VIIRS era · ${SAT_LABEL[m.source] ?? m.source} converted to MODIS units`;
  return m.era;
}

/** The raw VIIRS series the harmonized value is built from in the VIIRS era (S-NPP unless it has ended). */
export function viirsRaw(m: MonthRow): number | null {
  if (m.source === "viirs_n20") return m.viirs_n20_raw;
  if (m.source === "viirs_n21") return m.viirs_n21_raw;
  return m.viirs_snpp_raw ?? m.viirs_n20_raw ?? m.viirs_n21_raw;
}

// ---- small statistics
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
export const median = (values: number[]) => quantile([...values].sort((a, b) => a - b), 0.5);

/** Theil-Sen line: median of pairwise slopes, median intercept. Robust to single extreme years. */
export function theilSen(x: number[], y: number[]): { slope: number; intercept: number } | null {
  const slopes: number[] = [];
  for (let i = 0; i < x.length; i++)
    for (let j = i + 1; j < x.length; j++) if (x[j] !== x[i]) slopes.push((y[j] - y[i]) / (x[j] - x[i]));
  if (slopes.length < 3) return null;
  const slope = median(slopes);
  return { slope, intercept: median(y.map((v, i) => v - slope * x[i])) };
}

export function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
}

/** Median harmonized value per month-of-year over complete months (index 1..12). */
export function monthlyMedians(months: MonthRow[]): (number | null)[] {
  const out: (number | null)[] = [null];
  for (let moy = 1; moy <= 12; moy++) {
    const v = months.filter((m) => m.moy === moy && !m.partial && m.harmonized != null).map((m) => m.harmonized!);
    out.push(v.length ? median(v) : null);
  }
  return out;
}

// ---- colour scales
// Sequential: inferno, perceptually uniform and colourblind-safe. The darkest 12 % is skipped so the
// smallest non-zero value is still visible on the near-black UI; zero gets its own neutral fill.
export const inferno = (t: number) => interpolateInferno(0.12 + 0.86 * Math.max(0, Math.min(1, t)));
// Diverging: the ColorBrewer PuOr hues (orange = more burning than usual, purple = less; never red-green),
// re-stepped for a dark surface: the midpoint is a neutral dark grey that recedes into the UI ("nothing
// unusual"), and both arms get lighter as the departure grows, so magnitude also reads without hue.
const puor = piecewise(interpolateLab, [
  "#d8daeb", "#b2abd2", "#8073ac", "#542788", "#2b2e33", "#7f3b08", "#b35806", "#e08214", "#fdb863",
]);
export const diverging = (t: number) => puor(0.5 + 0.5 * Math.max(-1, Math.min(1, t)));
export const ANOMALY_CLAMP = 3; // colour saturates at 8x above / below the median (log2 ratio of 3)

export interface ValueScale {
  color: (v: number) => string;
  kind: "log" | "quantile";
  max: number;
  breaks: number[]; // quantile class edges (empty for log)
  classes: string[];
}

export function makeValueScale(values: number[], kind: "log" | "quantile"): ValueScale {
  const pos = values.filter((v) => v > 0).sort((a, b) => a - b);
  const max = pos.length ? pos[pos.length - 1] : 1;
  if (kind === "log" || pos.length < 7) {
    const denom = Math.log1p(max) || 1;
    return { kind: "log", max, breaks: [], classes: [], color: (v) => (v > 0 ? inferno(Math.log1p(v) / denom) : T.zero) };
  }
  const n = 7; // no more than ~7 colour classes stay distinguishable
  const breaks = Array.from({ length: n - 1 }, (_, i) => quantile(pos, (i + 1) / n));
  const classes = Array.from({ length: n }, (_, i) => inferno(i / (n - 1)));
  return {
    kind: "quantile", max, breaks, classes,
    color: (v) => (v > 0 ? classes[breaks.filter((b) => v > b).length] : T.zero),
  };
}

/** log2 of (value / median) with +1 smoothing, so months with a zero median stay defined. */
export const anomalyScore = (v: number, med: number) => Math.log2((v + 1) / (med + 1));

// ---- selection geometry (for drawing on the map; the API does the real spatial work)
export function circleRing(lat: number, lon: number, radiusKm: number, n = 72): [number, number][] {
  const d = radiusKm / 6371.0088;
  const phi = (lat * Math.PI) / 180;
  const lam = (lon * Math.PI) / 180;
  const ring: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const th = (2 * Math.PI * k) / n;
    const phi2 = Math.asin(Math.sin(phi) * Math.cos(d) + Math.cos(phi) * Math.sin(d) * Math.cos(th));
    const lam2 = lam + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(phi), Math.cos(d) - Math.sin(phi) * Math.sin(phi2));
    ring.push([(lam2 * 180) / Math.PI, (phi2 * 180) / Math.PI]);
  }
  return ring;
}

export function selectionRing(sel: Selection, regions: RegionInfo[]): [number, number][] | null {
  if (sel.type === "polygon") return sel.ring;
  if (sel.type === "circle") return circleRing(sel.lat, sel.lon, sel.radius_km);
  const box = sel.type === "bbox" ? sel.bbox : regions.find((r) => r.id === sel.id)?.bbox;
  if (!box) return null;
  const [w, s, e, n] = box;
  return [[w, s], [e, s], [e, n], [w, n]];
}

export function selectionLabel(sel: Selection, regions: RegionInfo[]): string {
  if (sel.type === "region") return regions.find((r) => r.id === sel.id)?.name ?? sel.id;
  if (sel.type === "bbox") return `Rectangle ${sel.bbox.map((v) => v.toFixed(2)).join(", ")} (W, S, E, N)`;
  if (sel.type === "circle") return `${sel.radius_km} km around ${sel.lat.toFixed(3)}°, ${sel.lon.toFixed(3)}°`;
  return `Polygon, ${sel.ring.length} vertices`;
}
