// Data layer for the static website. Everything is computed in the browser from the files
// written by `python -m pipeline.run export-static` (see pipeline/export_static.py), so the site
// runs on plain web hosting such as GoDaddy cPanel. The numbers are the same ones the FastAPI
// service returns: region selections use the exact precomputed region series; custom areas are
// summed from 0.1-degree grid cells whose centre lies inside the shape.

export type Metric = "count" | "celldays";

export type Selection =
  | { type: "region"; id: string }
  | { type: "bbox"; bbox: [number, number, number, number] } // west, south, east, north
  | { type: "circle"; lat: number; lon: number; radius_km: number }
  | { type: "polygon"; ring: [number, number][] }; // [lon, lat], open ring

export interface MonthRow {
  month: string;
  year: number;
  moy: number;
  harmonized: number | null;
  lo: number | null;
  hi: number | null;
  modis_raw: number | null;
  terra_raw: number | null;
  aqua_raw: number | null;
  viirs_snpp_raw: number | null;
  viirs_n20_raw: number | null;
  viirs_n21_raw: number | null;
  source: string;
  era: string;
  method: string;
  terra_only: boolean;
  partial: boolean;
  days_observed: number;
  days_in_month: number;
}

export interface Meta {
  regions: string[];
  metric: Metric;
  unit: string;
  band: string;
  include_nonveg_types: boolean;
  pipeline_run_utc: string;
  served_utc: string;
  citation: string;
  approximate: boolean; // custom area summed from grid cells
}

export interface Kpis {
  n_months: number;
  n_complete_months: number;
  totals: { harmonized: number; modis_raw: number; viirs_snpp_raw: number; viirs_n20_raw: number; viirs_n21_raw: number };
  latest_month?: {
    month: string;
    value: number;
    historical_median: number | null;
    ratio_to_median: number | null;
    percentile_rank: number | null;
    n_other_years: number;
  };
  peak_month?: { moy: number; value: number; basis: "median" | "mean" };
  record_year?: { year: number; value: number; n_complete_years: number };
}

export interface RegionInfo {
  id: string;
  name: string;
  bbox: [number, number, number, number];
  start: string;
  end: string;
}

export interface RegionsResponse {
  data_range: { start: string; end: string };
  last_day: string | null;
  regions: RegionInfo[];
  citation: string;
}

export interface CellsResponse {
  cell_deg: number;
  start: string;
  end: string;
  west: number[];
  south: number[];
  value: number[];
}

export interface Query {
  sel: Selection;
  from: string | null;
  to: string | null;
  metric: Metric;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

// ------------------------------------------------------------------ files

interface RegionIndex extends RegionInfo {
  files: { cells_h: { n: number }; cells_raw: { n: number } };
  hot: Record<string, { n: number; bytes: number; last: string }>;
  last_day: string | null;
}

interface Index {
  generated_utc: string;
  pipeline_run_utc: string;
  grid: { cell_per_deg: number; fine_per_deg: number; tile_per_deg: number };
  cleaning: { include_nonveg_types: boolean };
  band: string;
  citation: string;
  data_range: { start: string; end: string };
  last_day: string | null;
  series: string[];
  predictors: string[];
  sats: string[];
  uncertainty: Record<string, (string | number | null)[]>;
  regions: RegionIndex[]; // world blocks that hold data
  presets: { id: string; name: string; bbox: [number, number, number, number] }[];
  map_tiles: { n: number };
  recent: Record<string, { n: number }>;
}

type SeriesFile = Record<string, (string | number | boolean | null)[]>;

const DATA = `${import.meta.env.BASE_URL}data`;
const cache = new Map<string, Promise<unknown>>();

function load<T>(path: string, kind: "json" | "bin"): Promise<T> {
  if (!cache.has(path)) {
    const p = fetch(`${DATA}/${path}`)
      .then((r) => {
        if (!r.ok) throw new ApiError(r.status, "missing_file", `Data file ${path} could not be loaded (${r.status}).`);
        return kind === "json" ? r.json() : r.arrayBuffer();
      })
      .catch((e) => {
        cache.delete(path);
        if (e instanceof ApiError) throw e;
        throw new ApiError(0, "unreachable", `Data file ${path} could not be loaded. Check that the data folder was uploaded.`);
      });
    cache.set(path, p);
  }
  return cache.get(path) as Promise<T>;
}

const index = () => load<Index>("index.json", "json");
const seriesFile = (rid: string) => load<SeriesFile>(`r/${rid}/series.json`, "json");

/** Read padded little-endian column blocks (see pipeline/export_static.py). */
function columns(buf: ArrayBuffer, n: number, spec: [string, "u8" | "i8" | "u16" | "i32" | "u32" | "f32"][]) {
  const size = { u8: 1, i8: 1, u16: 2, i32: 4, u32: 4, f32: 4 };
  const ctor = { u8: Uint8Array, i8: Int8Array, u16: Uint16Array, i32: Int32Array, u32: Uint32Array, f32: Float32Array };
  const out: Record<string, ArrayLike<number>> = {};
  let off = 0;
  for (const [name, t] of spec) {
    out[name] = new ctor[t](buf, off, n);
    off += n * size[t];
    off += (4 - (off % 4)) % 4;
  }
  return out;
}

interface CellsH { m: ArrayLike<number>; ix: ArrayLike<number>; iy: ArrayLike<number>; hc: ArrayLike<number>; hd: ArrayLike<number>; n: number }
interface CellsRaw { m: ArrayLike<number>; ix: ArrayLike<number>; iy: ArrayLike<number>; s: ArrayLike<number>; n_: ArrayLike<number>; cd: ArrayLike<number>; n: number }

async function cellsH(r: RegionIndex): Promise<CellsH> {
  const buf = await load<ArrayBuffer>(`r/${r.id}/cells_h.bin`, "bin");
  const n = r.files.cells_h.n;
  return { ...(columns(buf, n, [["m", "u16"], ["ix", "u16"], ["iy", "u16"], ["hc", "f32"], ["hd", "f32"]]) as unknown as Omit<CellsH, "n">), n };
}

async function cellsRaw(r: RegionIndex): Promise<CellsRaw> {
  const buf = await load<ArrayBuffer>(`r/${r.id}/cells_raw.bin`, "bin");
  const n = r.files.cells_raw.n;
  const c = columns(buf, n, [["m", "u16"], ["ix", "u16"], ["iy", "u16"], ["s", "u8"], ["n_", "u32"], ["cd", "u16"]]);
  return { ...(c as unknown as Omit<CellsRaw, "n">), n };
}

export interface Hotspots {
  n: number;
  lat: ArrayLike<number>; lon: ArrayLike<number>; frp: ArrayLike<number>; day: ArrayLike<number>;
  time: ArrayLike<number>; sat: ArrayLike<number>; conf: ArrayLike<number>; type: ArrayLike<number>;
  dn: ArrayLike<number>; proc: ArrayLike<number>; year: number;
}

/** One month of cleaned hotspots for a region (files are split by month to keep downloads small). */
async function hotspots(r: RegionIndex, year: number, month: number): Promise<Hotspots | null> {
  const key = `${year}-${String(month).padStart(2, "0")}`;
  const meta = r.hot[key];
  if (!meta) return null;
  const buf = await load<ArrayBuffer>(`r/${r.id}/hot/${key}.bin`, "bin");
  const c = columns(buf, meta.n, [["lat", "i32"], ["lon", "i32"], ["frp", "f32"], ["day", "u16"], ["time", "u16"],
    ["sat", "u8"], ["conf", "u8"], ["type", "i8"], ["dn", "u8"], ["proc", "u8"]]);
  return { ...(c as unknown as Omit<Hotspots, "n" | "year">), n: meta.n, year };
}

/** Year-month pairs from d0 to d1 inclusive (YYYY-MM-DD strings). */
function monthsBetween(d0: string, d1: string): [number, number][] {
  const out: [number, number][] = [];
  let y = Number(d0.slice(0, 4)), m = Number(d0.slice(5, 7));
  const y1 = Number(d1.slice(0, 4)), m1 = Number(d1.slice(5, 7));
  while (y < y1 || (y === y1 && m <= m1)) {
    out.push([y, m]);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

// ------------------------------------------------------------------ geometry

const monthIndex = (ym: string) => (Number(ym.slice(0, 4)) - 2000) * 12 + Number(ym.slice(5, 7)) - 1;
const monthText = (m: number) => `${2000 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}`;

function circleRing(lat: number, lon: number, km: number, n = 96): [number, number][] {
  const d = km / 6371.0088, phi = (lat * Math.PI) / 180, lam = (lon * Math.PI) / 180;
  const ring: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const th = (2 * Math.PI * k) / n;
    const p2 = Math.asin(Math.sin(phi) * Math.cos(d) + Math.cos(phi) * Math.sin(d) * Math.cos(th));
    const l2 = lam + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(phi), Math.cos(d) - Math.sin(phi) * Math.sin(p2));
    ring.push([(l2 * 180) / Math.PI, (p2 * 180) / Math.PI]);
  }
  return ring;
}

interface Shape {
  ring: [number, number][];
  bbox: [number, number, number, number];
  contains: (lon: number, lat: number) => boolean;
}

function shapeOf(sel: Selection, regions: RegionInfo[]): Shape {
  let ring: [number, number][];
  if (sel.type === "polygon") ring = sel.ring;
  else if (sel.type === "circle") ring = circleRing(sel.lat, sel.lon, sel.radius_km);
  else {
    const box = sel.type === "bbox" ? sel.bbox : regions.find((r) => r.id === sel.id)?.bbox;
    if (!box) throw new ApiError(404, "unknown_region", `Unknown region "${(sel as { id: string }).id}".`);
    const [w, s, e, n] = box;
    ring = [[w, s], [e, s], [e, n], [w, n]];
  }
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const bbox: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const isBox = sel.type === "region" || sel.type === "bbox";
  const contains = isBox
    ? (x: number, y: number) => x >= bbox[0] && x < bbox[2] && y >= bbox[1] && y < bbox[3]
    : (x: number, y: number) => {
        if (x < bbox[0] || x > bbox[2] || y < bbox[1] || y > bbox[3]) return false;
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i], [xj, yj] = ring[j];
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
      };
  return { ring, bbox, contains };
}

const overlaps = (a: number[], b: number[]) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

// ------------------------------------------------------------------ uncertainty band (port of pipeline/uncertainty.py)

const BIN_EDGES = [0, 1, 3, 10, 30, 100, 300, 1000, 3000, 10000, 30000, 100000, Infinity];
const MIN_N = 30;

function bandLookup(idx: Index) {
  const u = idx.uncertainty;
  const rows = new Map<string, [number, number, number]>();
  for (let i = 0; i < u.predictor.length; i++)
    rows.set(`${u.predictor[i]}|${u.metric[i]}|${u.region[i]}|${u.bin[i]}`, [Number(u.n[i]), Number(u.q05[i]), Number(u.q95[i])]);
  return (predictor: string, metric: string, region: string, v: number): [number, number] | null => {
    let b = BIN_EDGES.filter((e) => e <= v).length - 1;
    b = Math.max(0, Math.min(BIN_EDGES.length - 2, b));
    const keys: string[] = [];
    for (let s = b; s >= 0; s--) keys.push(`${predictor}|${metric}|${region}|${s}`, `${predictor}|${metric}|*|${s}`);
    keys.push(`${predictor}|${metric}|${region}|-1`, `${predictor}|${metric}|*|-1`);
    for (const k of keys) {
      const row = rows.get(k);
      if (row && row[0] >= MIN_N)
        return [Math.min(v, Math.max(0, (v + 1) * Math.exp(row[1]) - 1)), Math.max(v, (v + 1) * Math.exp(row[2]) - 1)];
    }
    return null;
  };
}

// ------------------------------------------------------------------ public API

export async function fetchRegions(): Promise<RegionsResponse> {
  const idx = await index();
  return {
    data_range: idx.data_range,
    last_day: idx.last_day,
    // the area menu lists the named shortcuts; the world blocks stay internal
    regions: idx.presets.map(({ id, name, bbox }) => ({ id, name, bbox, start: idx.data_range.start, end: idx.data_range.end })),
    citation: idx.citation,
  };
}

export async function lastDay(): Promise<string | null> {
  return (await index()).last_day;
}

const SERIES_OUT = ["modis", "terra", "aqua", "viirs_snpp", "viirs_n20", "viirs_n21"] as const;

interface Wide { [col: string]: number | string | boolean | null }

/** Monthly rows (all metrics) for one region, either exact or summed from cells inside the shape. */
async function regionRows(idx: Index, r: RegionIndex, shape: Shape | null): Promise<Wide[]> {
  const s = await seriesFile(r.id);
  const n = (s.month as string[]).length;
  const rows: Wide[] = [];
  for (let i = 0; i < n; i++) {
    const row: Wide = {};
    for (const k of Object.keys(s)) row[k] = s[k][i];
    rows.push(row);
  }
  if (!shape) return rows;

  // custom area: re-sum raw and harmonized values over cells whose centre is inside
  const C = idx.grid.cell_per_deg;
  const insideCache = new Map<number, boolean>();
  const inside = (ix: number, iy: number) => {
    const key = ix * 4000 + iy;
    let v = insideCache.get(key);
    if (v === undefined) {
      v = shape.contains((ix + 0.5) / C - 180, (iy + 0.5) / C - 90);
      insideCache.set(key, v);
    }
    return v;
  };
  const pos = new Map<number, number>();
  rows.forEach((row, i) => pos.set(monthIndex(row.month as string), i));
  const sums = rows.map(() => ({ raw: new Float64Array(12), hc: 0, hd: 0 }));
  const [raw, h] = await Promise.all([cellsRaw(r), cellsH(r)]);
  for (let i = 0; i < raw.n; i++) {
    if (!inside(raw.ix[i], raw.iy[i])) continue;
    const p = pos.get(raw.m[i]);
    if (p === undefined) continue;
    sums[p].raw[raw.s[i]] += raw.n_[i];
    sums[p].raw[6 + raw.s[i]] += raw.cd[i];
  }
  for (let i = 0; i < h.n; i++) {
    if (!inside(h.ix[i], h.iy[i])) continue;
    const p = pos.get(h.m[i]);
    if (p === undefined) continue;
    sums[p].hc += h.hc[i];
    sums[p].hd += h.hd[i];
  }
  rows.forEach((row, i) => {
    SERIES_OUT.forEach((sname, si) => {
      if (row[`count_${sname}`] != null) row[`count_${sname}`] = sums[i].raw[si];
      if (row[`celldays_${sname}`] != null) row[`celldays_${sname}`] = sums[i].raw[6 + si];
    });
    if (row.h_count != null) row.h_count = sums[i].hc;
    if (row.h_celldays != null) row.h_celldays = sums[i].hd;
  });
  return rows;
}

function combine(perRegion: Wide[][]): Wide[] {
  if (perRegion.length === 1) return perRegion[0];
  const byMonth = new Map<string, Wide[]>();
  perRegion.flat().forEach((r) => byMonth.set(r.month as string, [...(byMonth.get(r.month as string) ?? []), r]));
  const join = (rs: Wide[], k: string) => [...new Set(rs.map((r) => String(r[k])))].sort().join("+");
  return [...byMonth.keys()].sort().map((month) => {
    const rs = byMonth.get(month)!;
    const out: Wide = { month, year: rs[0].year, moy: rs[0].moy };
    for (const k of Object.keys(rs[0])) {
      if (/^(count_|celldays_|h_count$|h_celldays$)/.test(k)) {
        const vals = rs.map((r) => r[k]).filter((v): v is number => v != null);
        out[k] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
      }
    }
    out.source = join(rs, "source");
    out.era = join(rs, "era");
    out.method_count = join(rs, "method_count");
    out.method_celldays = join(rs, "method_celldays");
    out.terra_only = rs.some((r) => r.terra_only);
    out.partial = rs.some((r) => r.partial);
    out.days_observed = Math.min(...rs.map((r) => Number(r.days_observed)));
    out.days_in_month = Math.max(...rs.map((r) => Number(r.days_in_month)));
    return out;
  });
}

interface Computed {
  months: MonthRow[];
  meta: Meta;
}

const memo = new Map<string, Promise<Computed>>();

export function fetchCalendar(q: Query): Promise<Computed> {
  const key = JSON.stringify(q);
  if (!memo.has(key)) {
    const p = compute(q);
    p.catch(() => memo.delete(key));
    memo.set(key, p);
    if (memo.size > 40) memo.delete(memo.keys().next().value!);
  }
  return memo.get(key)!;
}

async function compute(q: Query): Promise<Computed> {
  const idx = await index();
  const shape = shapeOf(q.sel, idx.presets as RegionInfo[]);
  const hit = idx.regions.filter((r) => overlaps(shape.bbox, r.bbox));
  if (!hit.length)
    throw new ApiError(404, "outside_coverage", "No fire detections exist anywhere in this area in the supplied data.");
  const isBox = q.sel.type === "region" || q.sel.type === "bbox";
  const [w, s, e, n] = shape.bbox;
  // A box whose edges lie on the 0.1-degree grid selects exactly the cells (and detections) inside it.
  const aligned = isBox && shape.bbox.every((v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-6);
  // A block entirely inside a box selection uses its precomputed series directly.
  const whole = (r: RegionIndex) => isBox && r.bbox[0] >= w && r.bbox[1] >= s && r.bbox[2] <= e && r.bbox[3] <= n;
  const per = await Promise.all(hit.map((r) => regionRows(idx, r, whole(r) ? null : shape)));
  let rows = combine(per);
  if (q.from) rows = rows.filter((r) => (r.month as string) >= q.from!);
  if (q.to) rows = rows.filter((r) => (r.month as string) <= q.to!);
  if (!rows.length)
    throw new ApiError(404, "no_data_in_range", `No data in this period. Data covers ${idx.data_range.start} to ${idx.data_range.end}.`);
  const detections = rows.reduce((t, r) => t + ["modis", "viirs_snpp", "viirs_n20", "viirs_n21"]
    .reduce((s, k) => s + (Number(r[`count_${k}`]) || 0), 0), 0);
  if (detections === 0)
    throw new ApiError(404, "empty_selection", "No hotspots were detected inside this area in the chosen period. Try a larger area or a longer period.");

  const m = q.metric;
  const band = bandLookup(idx);
  const used = hit.map((r) => r.id);
  const months: MonthRow[] = rows.map((r) => {
    const h = r[`h_${m}`] as number | null;
    let lo: number | null = null, hi: number | null = null;
    if (h != null) {
      if (r.source === "modis") lo = hi = h;
      else {
        const b = band(String(r.source), m, used.length === 1 ? used[0] : "*", h);
        if (b) [lo, hi] = b;
      }
    }
    return {
      month: r.month as string, year: Number(r.year), moy: Number(r.moy), harmonized: h, lo, hi,
      modis_raw: r[`${m}_modis`] as number | null, terra_raw: r[`${m}_terra`] as number | null,
      aqua_raw: r[`${m}_aqua`] as number | null, viirs_snpp_raw: r[`${m}_viirs_snpp`] as number | null,
      viirs_n20_raw: r[`${m}_viirs_n20`] as number | null, viirs_n21_raw: r[`${m}_viirs_n21`] as number | null,
      source: String(r.source), era: String(r.era), method: String(r[`method_${m}`] ?? ""),
      terra_only: Boolean(r.terra_only), partial: Boolean(r.partial),
      days_observed: Number(r.days_observed), days_in_month: Number(r.days_in_month),
    };
  });
  const approximate = !aligned && hit.some((r) => !whole(r));
  return {
    months,
    meta: {
      regions: used, metric: m,
      unit: m === "count" ? "MODIS-equivalent hotspots per month" : "MODIS-equivalent active cell-days per month (0.05 degree cells)",
      band: idx.band, include_nonveg_types: idx.cleaning.include_nonveg_types,
      pipeline_run_utc: idx.pipeline_run_utc, served_utc: idx.generated_utc, citation: idx.citation, approximate,
    },
  };
}

/** Key figures (port of api/store.py Store.summary). */
export function summarize(months: MonthRow[]): Kpis {
  const done = months.filter((m) => !m.partial && m.harmonized != null);
  const sum = (f: (m: MonthRow) => number | null) => months.reduce((s, m) => s + (f(m) ?? 0), 0);
  const out: Kpis = {
    n_months: months.length, n_complete_months: done.length,
    totals: {
      harmonized: sum((m) => m.harmonized), modis_raw: sum((m) => m.modis_raw),
      viirs_snpp_raw: sum((m) => m.viirs_snpp_raw), viirs_n20_raw: sum((m) => m.viirs_n20_raw), viirs_n21_raw: sum((m) => m.viirs_n21_raw),
    },
  };
  if (!done.length) return out;
  const med = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const ref = done[done.length - 1];
  const others = done.filter((m) => m.moy === ref.moy && m.month !== ref.month).map((m) => m.harmonized!);
  const median = others.length ? med(others) : null;
  out.latest_month = {
    month: ref.month, value: ref.harmonized!, historical_median: median,
    ratio_to_median: median ? ref.harmonized! / median : null,
    percentile_rank: others.length ? (100 * others.filter((v) => v <= ref.harmonized!).length) / others.length : null,
    n_other_years: others.length,
  };
  const byMoy = (f: (v: number[]) => number) =>
    Array.from({ length: 12 }, (_, i) => {
      const v = done.filter((m) => m.moy === i + 1).map((m) => m.harmonized!);
      return v.length ? f(v) : -Infinity;
    });
  let basis: "median" | "mean" = "median";
  let vals = byMoy(med);
  if (Math.max(...vals) === 0) {
    basis = "mean";
    vals = byMoy((v) => v.reduce((a, b) => a + b, 0) / v.length);
  }
  if (Math.max(...vals) > 0) out.peak_month = { moy: vals.indexOf(Math.max(...vals)) + 1, value: Math.max(...vals), basis };
  const years = new Map<number, number[]>();
  done.forEach((m) => years.set(m.year, [...(years.get(m.year) ?? []), m.harmonized!]));
  const full = [...years.entries()].filter(([, v]) => v.length === 12).map(([y, v]) => [y, v.reduce((a, b) => a + b, 0)] as const);
  if (full.length) {
    const best = full.reduce((a, b) => (b[1] > a[1] ? b : a));
    out.record_year = { year: best[0], value: best[1], n_complete_years: full.length };
  }
  return out;
}

export async function fetchSummary(q: Query): Promise<{ meta: Meta; kpis: Kpis }> {
  const c = await fetchCalendar(q);
  return { meta: c.meta, kpis: summarize(c.months) };
}

export interface View {
  bounds: [number, number, number, number]; // west, south, east, north of the visible map
  zoom: number;
}

/** Zoom at which the map switches from 1-degree tiles to 0.1-degree cells. */
export const DETAIL_ZOOM = 5;
/** Most world blocks whose files the map will load at once for detail or older detections. */
const MAX_VIEW_BLOCKS = 4;

const blocksInView = (idx: Index, v: View) => idx.regions.filter((r) => overlaps(v.bounds, r.bbox));

/**
 * Harmonized total over the period for the map layer. Zoomed out: 1-degree tiles for the whole world
 * (one small file). Zoomed in: 0.1-degree cells, read only for the world blocks on screen.
 */
export async function fetchCells(from: string | null, to: string | null, metric: Metric, view: View | null): Promise<CellsResponse> {
  const idx = await index();
  const m0 = monthIndex(from ?? idx.data_range.start), m1 = monthIndex(to ?? idx.data_range.end);
  const acc = new Map<number, number>();
  const blocks = view && view.zoom >= DETAIL_ZOOM ? blocksInView(idx, view) : [];
  let step: number;
  if (blocks.length && blocks.length <= MAX_VIEW_BLOCKS) {
    step = 1 / idx.grid.cell_per_deg;
    for (const r of blocks) {
      const h = await cellsH(r);
      const v = metric === "count" ? h.hc : h.hd;
      for (let i = 0; i < h.n; i++) {
        if (h.m[i] < m0 || h.m[i] > m1 || v[i] <= 0) continue;
        const key = h.ix[i] * 4000 + h.iy[i];
        acc.set(key, (acc.get(key) ?? 0) + v[i]);
      }
    }
  } else {
    step = 1;
    const buf = await load<ArrayBuffer>("map/tiles1.bin", "bin");
    const n = idx.map_tiles.n;
    const t = columns(buf, n, [["m", "u16"], ["tx", "u16"], ["ty", "u16"], ["hc", "f32"], ["hd", "f32"]]);
    const v = metric === "count" ? t.hc : t.hd;
    for (let i = 0; i < n; i++) {
      if (t.m[i] < m0 || t.m[i] > m1 || v[i] <= 0) continue;
      const key = t.tx[i] * 4000 + t.ty[i];
      acc.set(key, (acc.get(key) ?? 0) + v[i]);
    }
  }
  const west: number[] = [], south: number[] = [], value: number[] = [];
  acc.forEach((v, key) => {
    west.push(Math.floor(key / 4000) * step - 180);
    south.push((key % 4000) * step - 90);
    value.push(v);
  });
  return { cell_deg: step, start: monthText(m0), end: monthText(m1), west, south, value };
}

// ------------------------------------------------------------------ hotspot points

export interface Point { lon: number; lat: number; sat: string; date: string; time: string; frp: number; conf: string }

const CONF = (c: number) => (c === 201 ? "low" : c === 202 ? "nominal" : c === 203 ? "high" : String(c));
const dayText = (year: number, day: number) => new Date(Date.UTC(year, 0, 1 + day)).toISOString().slice(0, 10);

export interface PointsResult { points: Point[]; truncated: boolean; zoomIn: boolean }

/**
 * Detections between two dates (inclusive, YYYY-MM-DD). The latest days come from small worldwide
 * day files; older dates are read from the world blocks on screen, so they need a zoomed-in map.
 */
export async function fetchPoints(d0: string, d1: string, view: View | null, cap = 200_000): Promise<PointsResult> {
  const idx = await index();
  const points: Point[] = [];
  const days: string[] = [];
  for (let d = d0; d <= d1; d = new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10)) days.push(d);
  if (days.every((d) => idx.recent[d] || (idx.last_day && d > idx.last_day))) {
    for (const d of days) {
      const meta = idx.recent[d];
      if (!meta) continue;
      const buf = await load<ArrayBuffer>(`recent/${d}.bin`, "bin");
      const c = columns(buf, meta.n, [["lat", "i32"], ["lon", "i32"], ["frp", "f32"], ["time", "u16"], ["sat", "u8"], ["conf", "u8"]]);
      for (let i = 0; i < meta.n; i++) {
        if (points.length >= cap) return { points, truncated: true, zoomIn: false };
        points.push({ lon: c.lon[i] / 1e5, lat: c.lat[i] / 1e5, sat: idx.sats[c.sat[i]], date: d,
          time: String(c.time[i]).padStart(4, "0"), frp: c.frp[i], conf: CONF(c.conf[i]) });
      }
    }
    return { points, truncated: false, zoomIn: false };
  }
  const blocks = view ? blocksInView(idx, view) : [];
  if (!view || !blocks.length || blocks.length > MAX_VIEW_BLOCKS) return { points, truncated: false, zoomIn: true };
  const [w, s, e, n] = view.bounds;
  for (const r of blocks) {
    for (const [y, mo] of monthsBetween(d0, d1)) {
      const h = await hotspots(r, y, mo);
      if (!h) continue;
      for (let i = 0; i < h.n; i++) {
        const lon = h.lon[i] / 1e5, lat = h.lat[i] / 1e5;
        if (lon < w || lon > e || lat < s || lat > n) continue;
        const date = dayText(y, h.day[i]);
        if (date < d0 || date > d1) continue;
        if (points.length >= cap) return { points, truncated: true, zoomIn: false };
        points.push({ lon, lat, sat: idx.sats[h.sat[i]], date, time: String(h.time[i]).padStart(4, "0"), frp: h.frp[i], conf: CONF(h.conf[i]) });
      }
    }
  }
  return { points, truncated: false, zoomIn: false };
}

// ------------------------------------------------------------------ CSV exports

const MAX_EXPORT_ROWS = 500_000;

function noteLines(meta: Meta, label: string, extra: string[]): string {
  return [
    "Burning calendar - harmonized MODIS + VIIRS active-fire hotspots",
    `Selection: ${label}; regions: ${meta.regions.join(", ")}`,
    `Unit: ${meta.unit}`,
    "Data: FIRMS archive downloads supplied for the project, whole world, 2022-11-13 to 2026-11-13. " +
      "Method: VIIRS converted to MODIS-equivalent units with a transfer fitted where MODIS and VIIRS both observed, chosen " +
      "by leave-one-year-out validation. See METHODS.md.",
    `Uncertainty (lo, hi): ${meta.band}. Zero width where MODIS is observed directly.`,
    "Hotspots are satellite pixel detections, not individual fires. Cloud and smoke hide fires.",
    ...extra,
    `Pipeline run ${meta.pipeline_run_utc}; data files built ${meta.served_utc}; exported ${new Date().toISOString().slice(0, 19)}Z.`,
    meta.citation,
  ].map((l) => `# ${l}\n`).join("");
}

const csvCell = (v: unknown) => (v == null || (typeof v === "number" && !Number.isFinite(v)) ? "" : String(v));

export async function calendarCsv(q: Query, label: string): Promise<Blob> {
  const { months, meta } = await fetchCalendar(q);
  const cols = ["month", "year", "moy", "harmonized", "lo", "hi", "modis_raw", "terra_raw", "aqua_raw", "viirs_snpp_raw",
    "viirs_n20_raw", "viirs_n21_raw", "source", "era", "method", "terra_only", "partial", "days_observed", "days_in_month"] as const;
  const num = (v: number | null, d: number) => (v == null ? "" : v.toFixed(d));
  const body = months.map((m) => cols.map((c) => {
    const v = m[c];
    if (c === "harmonized" || c === "lo" || c === "hi") return num(v as number | null, 3);
    if (c.endsWith("_raw")) return v == null ? "" : String(Math.round(v as number));
    return csvCell(v);
  }).join(",")).join("\n");
  const extra = [
    "Columns: harmonized = value to use; lo/hi = band; *_raw = unadjusted detections per sensor; source = sensor the " +
      "harmonized value comes from; partial = month not fully observed.",
    ...(meta.approximate ? ["Custom area: values are summed over 0.1-degree grid cells whose centre lies inside the shape."] : []),
  ];
  return new Blob([noteLines(meta, label, extra), cols.join(","), "\n", body, "\n"], { type: "text/csv;charset=utf-8" });
}

export async function hotspotsCsv(q: Query, label: string): Promise<Blob> {
  const idx = await index();
  const { meta } = await fetchCalendar(q);
  const shape = shapeOf(q.sel, idx.presets as RegionInfo[]);
  const d0 = `${q.from ?? idx.data_range.start}-01`;
  const endM = q.to ?? idx.data_range.end;
  const d1 = new Date(Date.UTC(Number(endM.slice(0, 4)), Number(endM.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const C = idx.grid.cell_per_deg, k = C / idx.grid.tile_per_deg;
  const satSeries: Record<string, string> = { Terra: "terra", Aqua: "aqua", SNPP: "viirs_snpp", NOAA20: "viirs_n20", NOAA21: "viirs_n21" };
  const lines: string[] = [];
  let total = 0;
  for (const r of idx.regions.filter((r) => overlaps(shape.bbox, r.bbox))) {
    const series = await seriesFile(r.id);
    const sourceByMonth = new Map<number, string>();
    (series.month as string[]).forEach((mm, i) => sourceByMonth.set(monthIndex(mm), String(series.source[i])));
    const w = await load<{ m: number[]; tx: number[]; ty: number[]; p: number[]; w: (number | null)[] }>(`r/${r.id}/weights.json`, "json");
    const weight = new Map<string, number | null>();
    w.m.forEach((m, i) => weight.set(`${m}|${w.tx[i]}|${w.ty[i]}|${idx.predictors[w.p[i]]}`, w.w[i]));
    for (const [y, mo] of monthsBetween(d0, d1)) {
      const h = await hotspots(r, y, mo);
      if (!h) continue;
      for (let i = 0; i < h.n; i++) {
        const lon = h.lon[i] / 1e5, lat = h.lat[i] / 1e5;
        if (!shape.contains(lon, lat)) continue;
        const date = dayText(y, h.day[i]);
        if (date < d0 || date > d1) continue;
        if (++total > MAX_EXPORT_ROWS)
          throw new ApiError(413, "export_too_large", `More than ${MAX_EXPORT_ROWS.toLocaleString("en-US")} hotspots fall in this area and period. Shorten the period or draw a smaller area, then export again.`);
        const sat = idx.sats[h.sat[i]];
        const series = satSeries[sat];
        const m = (y - 2000) * 12 + Number(date.slice(5, 7)) - 1;
        const source = sourceByMonth.get(m);
        const observed = source === "modis" && (sat === "Terra" || sat === "Aqua");
        const type = h.type[i] < 0 ? null : h.type[i];
        const veg = idx.cleaning.include_nonveg_types || type === null || type === 0;
        const used = (observed || series === source) && veg;
        const tx = Math.floor(Math.floor((lon + 180) * C) / k), ty = Math.floor(Math.floor((lat + 90) * C) / k);
        const wt = !used ? 0 : observed ? 1 : weight.get(`${m}|${tx}|${ty}|${source}`) ?? null;
        lines.push([
          lat.toFixed(5), lon.toFixed(5), date, String(h.time[i]).padStart(4, "0"), sat === "Terra" || sat === "Aqua" ? "MODIS" : "VIIRS",
          sat, h.proc[i] ? "NRT" : "SP", CONF(h.conf[i]), Number.isFinite(h.frp[i]) ? h.frp[i].toFixed(2) : "",
          ["D", "N", ""][h.dn[i]], type ?? "", r.id, used ? "True" : "False", wt == null ? "" : wt.toFixed(5),
        ].join(","));
      }
    }
  }
  if (!lines.length) throw new ApiError(404, "empty_selection", "No hotspots were detected inside this area in the chosen period.");
  const extra = [
    "Rows: individual cleaned detections (MODIS confidence >= 30, VIIRS nominal/high), both sensors.",
    "harmonization_weight: what this detection adds to the harmonized count. The sum of this column equals the harmonized " +
      "total for the grid cells the detections fall in. 0 = not used (other sensor is the source that month, or a non-vegetation type).",
    "type (standard processing only): 0 vegetation fire, 1 volcano, 2 other static land source, 3 offshore.",
  ];
  const header = "latitude,longitude,acq_date,acq_time,sensor,satellite,processing,confidence,frp_mw,daynight,type,region,in_harmonized_series,harmonization_weight";
  return new Blob([noteLines(meta, label, extra), header, "\n", lines.join("\n"), "\n"], { type: "text/csv;charset=utf-8" });
}

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
