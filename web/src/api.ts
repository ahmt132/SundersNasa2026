// Data layer for the static website. Everything is computed in the browser from the files
// written by `python -m pipeline.run export-static` (see pipeline/export_static.py), so the site
// runs on static hosting (Cloudflare Pages for the page, Cloudflare R2 for the data). Box-shaped
// selections use the precomputed series of the world blocks they contain; other parts are summed
// from 0.1-degree grid cells whose centre lies inside the shape.

import { QUICK_AREAS } from "./areas";
import { type Cell, xlsxBlob } from "./xlsx";

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

export interface RegionInfo {
  id: string;
  name: string;
  bbox: [number, number, number, number];
  group: string;
}

export interface RegionsResponse {
  data_range: { start: string; end: string };
  first_day: string | null;
  last_day: string | null;
  regions: RegionInfo[];
  citation: string;
}

/** Map layer: harmonized total per grid cell over the period, as a dense grid. */
export interface CellsResponse {
  cell_deg: number;
  start: string;
  end: string;
  west: number;          // longitude of the grid's west edge
  south: number;         // latitude of the grid's south edge
  nx: number;
  ny: number;
  grid: Float32Array;    // nx * ny values, row 0 = southernmost; 0 = no fire
  max: number;
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
  files: {
    cells_h: { n: number }; cells_raw: { n: number };
    hall?: { n: number }; hy?: { n: number }; hm?: Record<string, { n: number }>;
    am?: string[]; // 5-degree chunks with area files (see areaRows)
  };
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
  coverage: { region: string; series: string; first: string; last: string }[];
  regions: RegionIndex[]; // world blocks that hold data
  map_tiles: { n: number };
  map_tiles_all?: { n: number };
  day_sample?: { cap: number; files: number }; // days/<YYYY>/<date>.bin, see fetchPoints
  map_tiles_y?: { n: number };
  map_tiles_m?: Record<string, { n: number }>;
  recent: Record<string, { n: number }>;
}

type SeriesFile = Record<string, (string | number | boolean | null)[]>;

// Where the data files live. Set VITE_DATA_URL at build time (for example
// https://data.example.org) when the data is served from a Cloudflare R2 bucket; without it the
// site reads the data folder next to the page (local development, `npm run dev`).
const DATA = String(import.meta.env.VITE_DATA_URL || `${import.meta.env.BASE_URL}data`).replace(/\/+$/, "");
const cache = new Map<string, Promise<unknown>>();

// ---- data kept in the browser between visits (Cache API)
// Data files never change without a new index.json, so they are stored under a name that contains
// the index's build time; a new build starts a new store and the old one is deleted. index.json
// itself is always fetched fresh. Any storage error (private mode, quota) just means no storage.
const STORE_PREFIX = "harmonic-heat-data-";
let storeName: string | null = null;
function setStoreVersion(version: string): void {
  const name = STORE_PREFIX + version;
  if (storeName === name) return;
  storeName = name;
  try {
    void caches.keys().then((keys) => keys.filter((k) => k.startsWith(STORE_PREFIX) && k !== name).forEach((k) => void caches.delete(k)));
  } catch { /* no Cache API */ }
}
async function fromStore(key: string): Promise<ArrayBuffer | null> {
  if (!storeName) return null;
  try {
    const hit = await (await caches.open(storeName)).match(key);
    return hit ? await hit.arrayBuffer() : null;
  } catch {
    return null;
  }
}
function toStore(key: string, buf: ArrayBuffer): void {
  if (!storeName) return;
  try {
    void caches.open(storeName).then((c) => c.put(key, new Response(buf.slice(0)))).catch(() => undefined);
  } catch { /* ignore */ }
}

// ---- download progress (for the loading screen)
// Bytes are counted as they arrive. Content-Length is the size on the wire; when the server
// compresses a file the decoded stream is longer, so each file's count is capped at its length.
export interface LoadProgress { received: number; expected: number; active: number }
const prog = { received: 0, expected: 0, active: 0 };
const progListeners = new Set<(p: LoadProgress) => void>();
const emitProgress = () => progListeners.forEach((f) => f({ ...prog }));
export function onLoadProgress(f: (p: LoadProgress) => void): () => void {
  progListeners.add(f);
  f({ ...prog });
  return () => void progListeners.delete(f);
}

async function readCounted(r: Response): Promise<ArrayBuffer> {
  const len = Number(r.headers.get("content-length")) || 0;
  prog.active++;
  prog.expected += len;
  emitProgress();
  let counted = 0;
  try {
    if (!r.body) return await r.arrayBuffer();
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      const add = (len ? Math.min(total, len) : 0) - counted;
      if (add > 0) { counted += add; prog.received += add; emitProgress(); }
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out.buffer;
  } finally {
    prog.received += len - counted; // finished (or failed): the file no longer counts as pending
    prog.active--;
    emitProgress();
  }
}

function load<T>(path: string, kind: "json" | "bin"): Promise<T> {
  if (!cache.has(path)) {
    const url = `${DATA}/${path}`;
    const persist = path !== "index.json";
    const p = (persist ? fromStore(url) : Promise.resolve(null))
      .then(async (stored) => {
        if (stored) return stored;
        const r = await fetch(url);
        if (!r.ok) throw new ApiError(r.status, "missing_file", `Data file ${path} could not be loaded (${r.status}).`);
        const buf = await readCounted(r);
        if (persist) toStore(url, buf);
        return buf;
      })
      .then((buf) => (kind === "json" ? JSON.parse(new TextDecoder().decode(buf)) : buf))
      .catch((e) => {
        cache.delete(path);
        if (e instanceof ApiError) throw e;
        throw new ApiError(0, "unreachable", `Data file ${path} could not be loaded. Check that the data was uploaded and that the data address allows this site (CORS).`);
      });
    cache.set(path, p);
  }
  return cache.get(path) as Promise<T>;
}

/**
 * Bytes [start, end) of a data file, fetched with an HTTP Range request so large files are not
 * downloaded whole. If the server ignores the range (status 200), the full answer is sliced.
 */
function loadRange(path: string, start: number, end: number): Promise<ArrayBuffer> {
  const key = `${path}#${start}-${end}`;
  if (end <= start) return Promise.resolve(new ArrayBuffer(0));
  if (!cache.has(key)) {
    const storeKey = `${DATA}/${path}?bytes=${start}-${end}`;
    const p = fromStore(storeKey)
      .then(async (stored) => {
        if (stored) return stored;
        const r = await fetch(`${DATA}/${path}`, { headers: { Range: `bytes=${start}-${end - 1}` } });
        if (!r.ok) throw new ApiError(r.status, "missing_file", `Data file ${path} could not be loaded (${r.status}).`);
        const buf = await readCounted(r);
        const part = r.status === 206 ? buf : buf.slice(start, end);
        toStore(storeKey, part);
        return part;
      })
      .catch((e) => {
        cache.delete(key);
        if (e instanceof ApiError) throw e;
        throw new ApiError(0, "unreachable", `Data file ${path} could not be loaded. Check that the data was uploaded and that the data address allows this site (CORS).`);
      });
    cache.set(key, p);
  }
  return cache.get(key) as Promise<ArrayBuffer>;
}

const index = () => load<Index>("index.json", "json").then((idx) => { setStoreVersion(idx.generated_utc); return idx; });
const seriesFile = (rid: string) => load<SeriesFile>(`r/${rid}/series.json`, "json");

/** Read padded little-endian column blocks (see pipeline/export_static.py). */
function columns(buf: ArrayBuffer, n: number, spec: [string, "u8" | "i8" | "u16" | "i32" | "u32" | "f32"][], start = 0) {
  const size = { u8: 1, i8: 1, u16: 2, i32: 4, u32: 4, f32: 4 };
  const ctor = { u8: Uint8Array, i8: Int8Array, u16: Uint16Array, i32: Int32Array, u32: Uint32Array, f32: Float32Array };
  const out: Record<string, ArrayLike<number>> = {};
  let off = start;
  for (const [name, t] of spec) {
    out[name] = new ctor[t](buf, off, n);
    off += n * size[t];
    off += (4 - (off % 4)) % 4;
  }
  return out;
}

/** Byte length of a column-block section (each column padded to 4 bytes). */
function sectionBytes(n: number, spec: [string, "u8" | "i8" | "u16" | "i32" | "u32" | "f32"][]) {
  const size = { u8: 1, i8: 1, u16: 2, i32: 4, u32: 4, f32: 4 };
  return spec.reduce((off, [, t]) => off + n * size[t] + ((4 - ((n * size[t]) % 4)) % 4), 0);
}

/** Two-section area file (export_static.export_areas): header nr, nh, then raw rows, then harmonized rows. */
function areaFile(buf: ArrayBuffer, rawSpec: [string, "u8" | "u16" | "u32" | "f32"][]) {
  const [nr, nh] = new Uint32Array(buf, 0, 2);
  const hSpec: [string, "u16" | "f32"][] = [["m", "u16"], ["x", "u16"], ["y", "u16"], ["hc", "f32"], ["hd", "f32"]];
  return {
    nr, nh,
    raw: columns(buf, nr, rawSpec, 8),
    h: columns(buf, nh, hSpec, 8 + sectionBytes(nr, rawSpec)),
  };
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

const HOT_SPEC: [string, "u8" | "i8" | "u16" | "i32" | "f32"][] = [["lat", "i32"], ["lon", "i32"], ["frp", "f32"], ["day", "u16"],
  ["time", "u16"], ["sat", "u8"], ["conf", "u8"], ["type", "i8"], ["dn", "u8"], ["proc", "u8"]];
const HOT_SIZE = { u8: 1, i8: 1, u16: 2, i32: 4, f32: 4 } as const;
const HOT_CTOR = { u8: Uint8Array, i8: Int8Array, u16: Uint16Array, i32: Int32Array, f32: Float32Array } as const;
const dayOfYear = (year: number, date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.UTC(year, 0, 1)) / 864e5);

/**
 * Cleaned hotspots of one region and month (files are split by month; rows are in date order).
 * With d0/d1 (YYYY-MM-DD) covering only part of the month, just those days are fetched: first the
 * small day column, then the matching rows of every other column, each with a Range request.
 */
/** Columns the map dots use; the hotspot download needs all of them. */
const MAP_COLS = new Set(["lat", "lon", "frp", "day", "time", "sat", "conf"]);

async function hotspots(r: RegionIndex, year: number, month: number, d0?: string, d1?: string,
  only?: Set<string>): Promise<Hotspots | null> {
  const key = `${year}-${String(month).padStart(2, "0")}`;
  const meta = r.hot[key];
  if (!meta) return null;
  const path = `r/${r.id}/hot/${key}.bin`;
  const n = meta.n;
  const first = dayOfYear(year, `${key}-01`);
  const last = dayOfYear(year, new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10));
  const want0 = d0 ? Math.max(first, dayOfYear(year, d0)) : first;
  const want1 = d1 ? Math.min(last, dayOfYear(year, d1)) : last;
  if (want0 > want1) return null;
  const wholeMonth = want0 <= first && want1 >= last;
  if (wholeMonth && !only) {
    const buf = await load<ArrayBuffer>(path, "bin");
    const c = columns(buf, n, HOT_SPEC);
    return { ...(c as unknown as Omit<Hotspots, "n" | "year">), n, year };
  }
  // byte offset of each column block (each block padded to 4 bytes, as written by export_static)
  const offs: number[] = [];
  let off = 0;
  for (const [, t] of HOT_SPEC) {
    offs.push(off);
    off += n * HOT_SIZE[t];
    off += (4 - (off % 4)) % 4;
  }
  // whole month: every row; part of a month: read the day column first to find the rows
  let i0 = 0, i1 = n, dayCol: Uint16Array | null = null;
  if (!wholeMonth) {
    dayCol = new Uint16Array(await loadRange(path, offs[3], offs[3] + 2 * n));
    const col = dayCol;
    const lower = (v: number) => { let lo = 0, hi = n; while (lo < hi) { const mid = (lo + hi) >> 1; if (col[mid] < v) lo = mid + 1; else hi = mid; } return lo; };
    i0 = lower(want0);
    i1 = lower(want1 + 1);
  }
  const m = i1 - i0;
  const parts = await Promise.all(HOT_SPEC.map(async ([name, t], ci) => {
    if (only && !only.has(name)) return new HOT_CTOR[t](0);
    if (name === "day" && dayCol) return dayCol.slice(i0, i1);
    const sz = HOT_SIZE[t];
    const buf = await loadRange(path, offs[ci] + i0 * sz, offs[ci] + i1 * sz);
    return new HOT_CTOR[t](buf);
  }));
  const c = Object.fromEntries(HOT_SPEC.map(([name], ci) => [name, parts[ci]]));
  return { ...(c as unknown as Omit<Hotspots, "n" | "year">), n: m, year };
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
    // first observed day of any satellite (the month range starts on the 1st of that month)
    first_day: idx.coverage.length ? idx.coverage.map((c) => c.first).sort()[0] : null,
    last_day: idx.last_day,
    // the area menu lists the quick areas (src/areas.ts); the world blocks stay internal
    regions: QUICK_AREAS,
    citation: idx.citation,
  };
}

const SERIES_OUT = ["modis", "terra", "aqua", "viirs_snpp", "viirs_n20", "viirs_n21"] as const;

interface Wide { [col: string]: number | string | boolean | null }

/**
 * Sum a shape's values from the place-split area files: 1-degree tile sums for tiles whose 100
 * cell centres are all inside the shape, 0.1-degree cells only for tiles on its edge. Gives the same
 * numbers as summing every cell of the block, but reads only the part of the world the shape covers.
 */
async function areaSums(r: RegionIndex, shape: Shape, C: number, inside: (ix: number, iy: number) => boolean,
  pos: Map<number, number>, sums: Sums): Promise<void> {
  const [w, s, e, n] = shape.bbox;
  const tx0 = Math.max(Math.floor(w + 180), Math.round(r.bbox[0] + 180)), tx1 = Math.min(Math.ceil(e + 180) - 1, Math.round(r.bbox[2] + 180) - 1);
  const ty0 = Math.max(Math.floor(s + 90), Math.round(r.bbox[1] + 90)), ty1 = Math.min(Math.ceil(n + 90) - 1, Math.round(r.bbox[3] + 90) - 1);
  if (tx0 > tx1 || ty0 > ty1) return;
  const have = new Set(r.files.am);
  const chunks: string[] = [];
  for (let cx = Math.floor(tx0 / 5); cx <= Math.floor(tx1 / 5); cx++)
    for (let cy = Math.floor(ty0 / 5); cy <= Math.floor(ty1 / 5); cy++) if (have.has(`${cx}_${cy}`)) chunks.push(`${cx}_${cy}`);
  // 0 = no cell centre inside, 1 = all inside, 2 = some (edge tile)
  const kind = new Map<number, number>();
  const tileKind = (tx: number, ty: number) => {
    const key = tx * 1000 + ty;
    let k = kind.get(key);
    if (k === undefined) {
      let nIn = 0;
      for (let i = 0; i < C; i++) for (let j = 0; j < C; j++) if (inside(tx * C + i, ty * C + j)) nIn++;
      k = nIn === 0 ? 0 : nIn === C * C ? 1 : 2;
      kind.set(key, k);
    }
    return k;
  };
  const edge = new Set<number>();
  const rawSpec: [string, "u8" | "u16" | "u32"][] = [["m", "u16"], ["x", "u16"], ["y", "u16"], ["s", "u8"], ["n", "u32"], ["cd", "u32"]];
  const within = (tx: number, ty: number) => tx >= tx0 && tx <= tx1 && ty >= ty0 && ty <= ty1;
  await Promise.all(chunks.map(async (key) => {
    const f = areaFile(await load<ArrayBuffer>(`r/${r.id}/am/${key}.bin`, "bin"), rawSpec);
    const a = f.raw, b = f.h;
    for (let i = 0; i < f.nr; i++) {
      if (!within(a.x[i], a.y[i])) continue;
      const k = tileKind(a.x[i], a.y[i]);
      if (k === 2) { edge.add(a.x[i] * 1000 + a.y[i]); continue; }
      if (k === 0) continue;
      const p = pos.get(a.m[i]);
      if (p === undefined) continue;
      sums[p].raw[a.s[i]] += a.n[i];
      sums[p].raw[6 + a.s[i]] += a.cd[i];
    }
    for (let i = 0; i < f.nh; i++) {
      if (!within(b.x[i], b.y[i])) continue;
      const k = tileKind(b.x[i], b.y[i]);
      if (k === 2) { edge.add(b.x[i] * 1000 + b.y[i]); continue; }
      if (k === 0) continue;
      const p = pos.get(b.m[i]);
      if (p === undefined) continue;
      sums[p].hc += b.hc[i];
      sums[p].hd += b.hd[i];
    }
  }));
  const cellSpec: [string, "u8" | "u16" | "u32"][] = [["m", "u16"], ["x", "u16"], ["y", "u16"], ["s", "u8"], ["n", "u32"], ["cd", "u16"]];
  await Promise.all([...edge].map(async (key) => {
    const f = areaFile(await load<ArrayBuffer>(`r/${r.id}/ac/${Math.floor(key / 1000)}_${key % 1000}.bin`, "bin"), cellSpec);
    const a = f.raw, b = f.h;
    for (let i = 0; i < f.nr; i++) {
      if (!inside(a.x[i], a.y[i])) continue;
      const p = pos.get(a.m[i]);
      if (p === undefined) continue;
      sums[p].raw[a.s[i]] += a.n[i];
      sums[p].raw[6 + a.s[i]] += a.cd[i];
    }
    for (let i = 0; i < f.nh; i++) {
      if (!inside(b.x[i], b.y[i])) continue;
      const p = pos.get(b.m[i]);
      if (p === undefined) continue;
      sums[p].hc += b.hc[i];
      sums[p].hd += b.hd[i];
    }
  }));
}

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
  if (r.files.am) {
    await areaSums(r, shape, C, inside, pos, sums);
    return fillRows(rows, sums);
  }
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
  return fillRows(rows, sums);
}

type Sums = { raw: Float64Array; hc: number; hd: number }[];

function fillRows(rows: Wide[], sums: Sums): Wide[] {
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
  const shape = shapeOf(q.sel, QUICK_AREAS);
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
type AddFn = (x: number, y: number, v: number) => void;
const SPLIT_COLS: [string, "u16" | "f32"][] = [["t", "u16"], ["x", "u16"], ["y", "u16"], ["hc", "f32"], ["hd", "f32"]];

/**
 * Add the map values of months m0..m1 from one year-split file set (see export_static.export_map):
 * the all-months total when the period covers the whole record, per-year sums for years the period
 * covers completely, and the monthly file only for a year the period cuts through. So the default view
 * reads one small file and a single month reads one year's file, not 26 years of months.
 */
async function addSplit(base: string, split: { all?: { n: number }; y?: { n: number }; m?: Record<string, { n: number }> },
  m0: number, m1: number, d0: number, d1: number, metric: Metric, add: AddFn): Promise<void> {
  const pick = (c: Record<string, ArrayLike<number>>) => (metric === "count" ? c.hc : c.hd);
  const run = (buf: ArrayBuffer, n: number, keep: (t: number) => boolean) => {
    const c = columns(buf, n, SPLIT_COLS);
    const v = pick(c);
    for (let i = 0; i < n; i++) if (v[i] > 0 && keep(c.t[i])) add(c.x[i], c.y[i], v[i]);
  };
  if (m0 <= d0 && m1 >= d1 && split.all) {
    if (split.all.n) run(await load<ArrayBuffer>(`${base}_all.bin`, "bin"), split.all.n, () => true);
    return;
  }
  const whole = new Uint8Array(256);
  const part: number[] = [];
  for (let y = Math.floor(Math.max(m0, d0) / 12); y <= Math.floor(Math.min(m1, d1) / 12); y++) {
    const a = Math.max(y * 12, d0), b = Math.min(y * 12 + 11, d1);
    if (m0 <= a && m1 >= b) whole[y] = 1;
    else part.push(y);
  }
  const jobs: Promise<void>[] = [];
  if (whole.some((f) => f) && split.y?.n) {
    const n = split.y.n;
    jobs.push(load<ArrayBuffer>(`${base}.bin`, "bin").then((buf) => run(buf, n, (t) => whole[t] === 1)));
  }
  for (const y of part) {
    const info = split.m?.[String(2000 + y)];
    if (!info?.n) continue;
    const dir = base.endsWith("/hy") ? base.replace(/\/hy$/, "/hm") : base.replace(/\/t1y$/, "/t1m");
    jobs.push(load<ArrayBuffer>(`${dir}/${2000 + y}.bin`, "bin").then((buf) => run(buf, info.n, (t) => t >= m0 && t <= m1)));
  }
  await Promise.all(jobs);
}

export async function fetchCells(from: string | null, to: string | null, metric: Metric, view: View | null): Promise<CellsResponse> {
  const idx = await index();
  const d0 = monthIndex(idx.data_range.start), d1 = monthIndex(idx.data_range.end);
  const m0 = monthIndex(from ?? idx.data_range.start), m1 = monthIndex(to ?? idx.data_range.end);
  const blocks = view && view.zoom >= DETAIL_ZOOM ? blocksInView(idx, view) : [];
  const split = Boolean(idx.map_tiles_y);
  let out: CellsResponse;
  if (blocks.length && blocks.length <= MAX_VIEW_BLOCKS) {
    // 0.1-degree cells; global cell indices ix = floor((lon + 180) * 10), iy = floor((lat + 90) * 10)
    const k = idx.grid.cell_per_deg;
    const ix0 = Math.round((Math.min(...blocks.map((r) => r.bbox[0])) + 180) * k);
    const iy0 = Math.round((Math.min(...blocks.map((r) => r.bbox[1])) + 90) * k);
    const nx = Math.round((Math.max(...blocks.map((r) => r.bbox[2])) + 180) * k) - ix0;
    const ny = Math.round((Math.max(...blocks.map((r) => r.bbox[3])) + 90) * k) - iy0;
    const grid = new Float32Array(nx * ny);
    const add: AddFn = (x, y, v) => {
      const gx = x - ix0, gy = y - iy0;
      if (gx >= 0 && gx < nx && gy >= 0 && gy < ny) grid[gy * nx + gx] += v;
    };
    await Promise.all(blocks.map(async (r) => {
      if (split && r.files.hy) {
        await addSplit(`r/${r.id}/hy`, { all: r.files.hall, y: r.files.hy, m: r.files.hm }, m0, m1, d0, d1, metric, add);
      } else {
        const h = await cellsH(r);
        const v = metric === "count" ? h.hc : h.hd;
        for (let i = 0; i < h.n; i++) if (h.m[i] >= m0 && h.m[i] <= m1 && v[i] > 0) add(h.ix[i], h.iy[i], v[i]);
      }
    }));
    out = { cell_deg: 1 / k, start: "", end: "", west: ix0 / k - 180, south: iy0 / k - 90, nx, ny, grid, max: 0 };
  } else {
    const nx = 360, ny = 180, grid = new Float32Array(nx * ny);
    const add: AddFn = (x, y, v) => { if (x < nx && y < ny) grid[y * nx + x] += v; };
    if (split) {
      await addSplit("map/t1y", { all: idx.map_tiles_all, y: idx.map_tiles_y, m: idx.map_tiles_m }, m0, m1, d0, d1, metric, add);
    } else {
      const buf = await load<ArrayBuffer>("map/tiles1.bin", "bin");
      const n = idx.map_tiles.n;
      const t = columns(buf, n, [["m", "u16"], ["tx", "u16"], ["ty", "u16"], ["hc", "f32"], ["hd", "f32"]]);
      const v = metric === "count" ? t.hc : t.hd;
      for (let i = 0; i < n; i++) if (t.m[i] >= m0 && t.m[i] <= m1 && v[i] > 0) add(t.tx[i], t.ty[i], v[i]);
    }
    out = { cell_deg: 1, start: "", end: "", west: -180, south: -90, nx, ny, grid, max: 0 };
  }
  let max = 0;
  for (let i = 0; i < out.grid.length; i++) if (out.grid[i] > max) max = out.grid[i];
  return { ...out, start: monthText(m0), end: monthText(m1), max };
}

// ------------------------------------------------------------------ hotspot points

export interface Point { lon: number; lat: number; sat: string; date: string; time: string; frp: number; conf: string }

const CONF = (c: number) => (c === 201 ? "low" : c === 202 ? "nominal" : c === 203 ? "high" : String(c));
const dayText = (year: number, day: number) => new Date(Date.UTC(year, 0, 1 + day)).toISOString().slice(0, 10);

export interface PointsResult {
  points: Point[];
  total: number;      // detections in the window and the visible area
  modis: number;      // of which MODIS (Terra, Aqua); the rest are VIIRS
  stride: number;     // 1 = all drawn; N = every Nth detection drawn (even sample across the window)
  zoomIn: boolean;    // older dates need a zoomed-in map
  sampled?: boolean;  // zoomed out on older dates: dots are a daily sample, total and modis are estimates
}

const inView = (v: View | null) => (lon: number, lat: number) =>
  !v || (lon >= v.bounds[0] && lon <= v.bounds[2] && lat >= v.bounds[1] && lat <= v.bounds[3]);

function thin(all: Point[], cap: number): Pick<PointsResult, "points" | "total" | "stride" | "modis"> {
  const modis = all.filter((p) => p.sat === "Terra" || p.sat === "Aqua").length;
  if (all.length <= cap) return { points: all, total: all.length, stride: 1, modis };
  const stride = Math.ceil(all.length / cap);
  return { points: all.filter((_, i) => i % stride === 0), total: all.length, stride, modis };
}

/**
 * Detections between two dates (inclusive, YYYY-MM-DD) inside the visible map area. The latest days
 * come from small worldwide day files; older dates are read from the world blocks on screen, so
 * they need a zoomed-in map. Above `cap` points an even sample is drawn and reported.
 */
export async function fetchPoints(d0: string, d1: string, view: View | null, cap = 200_000): Promise<PointsResult> {
  const idx = await index();
  const all: Point[] = [];
  const keep = inView(view);
  const days: string[] = [];
  for (let d = d0; d <= d1; d = new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10)) days.push(d);
  if (days.every((d) => idx.recent[d] || (idx.last_day && d > idx.last_day))) {
    for (const d of days) {
      const meta = idx.recent[d];
      if (!meta) continue;
      const buf = await load<ArrayBuffer>(`recent/${d}.bin`, "bin");
      const c = columns(buf, meta.n, [["lat", "i32"], ["lon", "i32"], ["frp", "f32"], ["time", "u16"], ["sat", "u8"], ["conf", "u8"]]);
      for (let i = 0; i < meta.n; i++) {
        const lon = c.lon[i] / 1e5, lat = c.lat[i] / 1e5;
        if (!keep(lon, lat)) continue;
        all.push({ lon, lat, sat: idx.sats[c.sat[i]], date: d, time: String(c.time[i]).padStart(4, "0"), frp: c.frp[i], conf: CONF(c.conf[i]) });
      }
    }
    return { ...thin(all, cap), zoomIn: false };
  }
  const blocks = view ? blocksInView(idx, view) : [];
  if (!view || !blocks.length || blocks.length > MAX_VIEW_BLOCKS) {
    if (!idx.day_sample) return { points: [], total: 0, stride: 1, modis: 0, zoomIn: true };
    // Zoomed out on older dates: each day's worldwide random sample (at most day_sample.cap dots).
    // Counts in view are estimated from the sample with the day's real totals (file header).
    let estTotal = 0, estModis = 0;
    const loaded = await Promise.all(days.map((d) =>
      load<ArrayBuffer>(`days/${d.slice(0, 4)}/${d}.bin`, "bin").then((buf) => ({ d, buf })).catch(() => null)));
    for (const f of loaded) {
      if (!f) continue;
      const [n, dayTotal] = new Uint32Array(f.buf, 0, 4);
      if (!n) continue;
      const scale = dayTotal / n;
      const c = columns(f.buf, n, [["lat", "i32"], ["lon", "i32"], ["frp", "f32"], ["time", "u16"], ["sat", "u8"], ["conf", "u8"]], 16);
      for (let i = 0; i < n; i++) {
        const lon = c.lon[i] / 1e5, lat = c.lat[i] / 1e5;
        if (!keep(lon, lat)) continue;
        const sat = idx.sats[c.sat[i]];
        estTotal += scale;
        if (sat === "Terra" || sat === "Aqua") estModis += scale;
        all.push({ lon, lat, sat, date: f.d, time: String(c.time[i]).padStart(4, "0"), frp: c.frp[i], conf: CONF(c.conf[i]) });
      }
    }
    const shown = thin(all, cap).points;
    const total = Math.round(estTotal);
    return { points: shown, total, modis: Math.round(estModis), stride: Math.max(1, Math.round(total / Math.max(shown.length, 1))), zoomIn: false, sampled: true };
  }
  const jobs = blocks.flatMap((r) => monthsBetween(d0, d1).map(([y, mo]) => ({ y, h: hotspots(r, y, mo, d0, d1, MAP_COLS) })));
  for (const job of jobs) {
    const h = await job.h; // all files download at the same time; results are read in order
    if (!h) continue;
    for (let i = 0; i < h.n; i++) {
      const lon = h.lon[i] / 1e5, lat = h.lat[i] / 1e5;
      if (!keep(lon, lat)) continue;
      const date = dayText(job.y, h.day[i]);
      if (date < d0 || date > d1) continue;
      all.push({ lon, lat, sat: idx.sats[h.sat[i]], date, time: String(h.time[i]).padStart(4, "0"), frp: h.frp[i], conf: CONF(h.conf[i]) });
    }
  }
  return { ...thin(all, cap), zoomIn: false };
}

// ------------------------------------------------------------------ exports (CSV and Excel)

const MAX_EXPORT_ROWS = 500_000;

/** One export as a table; written either as CSV (unchanged format) or as an Excel workbook. */
interface ExportTable {
  cols: string[];
  rows: Cell[][];
  notes: string[];
  decimals: Record<string, number>;
  widths: number[];
}

export type ExportFormat = "csv" | "xlsx";

function noteList(meta: Meta, label: string, extra: string[]): string[] {
  return [
    "Harmonic Heat - harmonized MODIS + VIIRS active-fire hotspots",
    `Selection: ${label}; regions: ${meta.regions.join(", ")}`,
    `Unit: ${meta.unit}`,
    "Data: FIRMS yearly country archives (MODIS 2000-2022, S-NPP 2012-2022, NOAA-20 2018-2022) and FIRMS archive downloads 2022-11-13 to 2026-11-13, whole world. " +
      "Method: VIIRS converted to MODIS-equivalent units with a transfer fitted where MODIS and VIIRS both observed, chosen " +
      "by leave-one-year-out validation. See METHODS.md.",
    `Uncertainty (lo, hi): ${meta.band}. Zero width where MODIS is observed directly.`,
    "Hotspots are satellite pixel detections, not individual fires. Cloud and smoke hide fires.",
    ...extra,
    `Pipeline run ${meta.pipeline_run_utc}; data files built ${meta.served_utc}; exported ${new Date().toISOString().slice(0, 19)}Z.`,
    meta.citation,
  ];
}

function toCsv(t: ExportTable): Blob {
  const dec = t.cols.map((c) => t.decimals[c]);
  const fmt = (v: Cell, d: number | undefined) =>
    v == null ? "" : typeof v === "number" ? (!Number.isFinite(v) ? "" : d == null ? String(v) : v.toFixed(d)) : v;
  const body = t.rows.map((r) => r.map((v, i) => fmt(v, dec[i])).join(",")).join("\n");
  const notes = t.notes.map((l) => `# ${l}\n`).join("");
  return new Blob([notes, t.cols.join(","), "\n", body, "\n"], { type: "text/csv;charset=utf-8" });
}

function toXlsx(t: ExportTable, dataName: string): Promise<Blob> {
  return xlsxBlob([
    { name: dataName, header: t.cols, rows: t.rows, decimals: t.decimals, widths: t.widths, freezeHeader: true },
    { name: "Notes", header: ["About this file"], rows: t.notes.map((n) => [n]), widths: [140] },
  ]);
}

const toText = (v: unknown): Cell => (v == null ? null : typeof v === "number" ? v : String(v));

async function calendarTable(q: Query, label: string): Promise<ExportTable> {
  const { months, meta } = await fetchCalendar(q);
  const cols = ["month", "year", "moy", "harmonized", "lo", "hi", "modis_raw", "terra_raw", "aqua_raw", "viirs_snpp_raw",
    "viirs_n20_raw", "viirs_n21_raw", "source", "era", "method", "terra_only", "partial", "days_observed", "days_in_month"] as const;
  const rows = months.map((m) => cols.map((c): Cell => {
    const v = m[c];
    if (c.endsWith("_raw")) return v == null ? null : Math.round(v as number);
    return toText(v);
  }));
  const extra = [
    "Columns: harmonized = value to use; lo/hi = band; *_raw = unadjusted detections per sensor; source = sensor the " +
      "harmonized value comes from; partial = month not fully observed.",
    ...(meta.approximate ? ["Custom area: values are summed over 0.1-degree grid cells whose centre lies inside the shape."] : []),
  ];
  return {
    cols: [...cols], rows, notes: noteList(meta, label, extra),
    decimals: { harmonized: 3, lo: 3, hi: 3 },
    widths: [11, 6, 5, 12, 12, 12, 10, 10, 10, 14, 13, 13, 11, 15, 9, 10, 8, 13, 13],
  };
}

async function hotspotsTable(q: Query, label: string): Promise<ExportTable> {
  const idx = await index();
  const { meta } = await fetchCalendar(q);
  const shape = shapeOf(q.sel, QUICK_AREAS);
  const d0 = `${q.from ?? idx.data_range.start}-01`;
  const endM = q.to ?? idx.data_range.end;
  const d1 = new Date(Date.UTC(Number(endM.slice(0, 4)), Number(endM.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const C = idx.grid.cell_per_deg, k = C / idx.grid.tile_per_deg;
  const satSeries: Record<string, string> = { Terra: "terra", Aqua: "aqua", SNPP: "viirs_snpp", NOAA20: "viirs_n20", NOAA21: "viirs_n21" };
  const rows: Cell[][] = [];
  for (const r of idx.regions.filter((r) => overlaps(shape.bbox, r.bbox))) {
    const series = await seriesFile(r.id);
    const sourceByMonth = new Map<number, string>();
    (series.month as string[]).forEach((mm, i) => sourceByMonth.set(monthIndex(mm), String(series.source[i])));
    const w = await load<{ m: number[]; tx: number[]; ty: number[]; p: number[]; w: (number | null)[] }>(`r/${r.id}/weights.json`, "json");
    const weight = new Map<string, number | null>();
    w.m.forEach((m, i) => weight.set(`${m}|${w.tx[i]}|${w.ty[i]}|${idx.predictors[w.p[i]]}`, w.w[i]));
    for (const [y, mo] of monthsBetween(d0, d1)) {
      const h = await hotspots(r, y, mo, d0, d1);
      if (!h) continue;
      for (let i = 0; i < h.n; i++) {
        const lon = h.lon[i] / 1e5, lat = h.lat[i] / 1e5;
        if (!shape.contains(lon, lat)) continue;
        const date = dayText(y, h.day[i]);
        if (date < d0 || date > d1) continue;
        if (rows.length >= MAX_EXPORT_ROWS)
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
        rows.push([
          lat, lon, date, String(h.time[i]).padStart(4, "0"), sat === "Terra" || sat === "Aqua" ? "MODIS" : "VIIRS",
          sat, h.proc[i] ? "NRT" : "SP", CONF(h.conf[i]), Number.isFinite(h.frp[i]) ? h.frp[i] : null,
          ["D", "N", ""][h.dn[i]], type, r.id, used ? "True" : "False", wt,
        ]);
      }
    }
  }
  if (!rows.length) throw new ApiError(404, "empty_selection", "No hotspots were detected inside this area in the chosen period.");
  const extra = [
    "Rows: individual cleaned detections (MODIS confidence >= 30, VIIRS nominal/high), both sensors.",
    "harmonization_weight: what this detection adds to the harmonized count. The sum of this column equals the harmonized " +
      "total for the grid cells the detections fall in. 0 = not used (other sensor is the source that month, or a non-vegetation type).",
    "type (standard processing only): 0 vegetation fire, 1 volcano, 2 other static land source, 3 offshore.",
  ];
  return {
    cols: ["latitude", "longitude", "acq_date", "acq_time", "sensor", "satellite", "processing", "confidence", "frp_mw",
      "daynight", "type", "region", "in_harmonized_series", "harmonization_weight"],
    rows, notes: noteList(meta, label, extra),
    decimals: { latitude: 5, longitude: 5, frp_mw: 2, harmonization_weight: 5 },
    widths: [10, 11, 11, 9, 7, 9, 10, 10, 8, 8, 5, 11, 18, 20],
  };
}

export async function calendarExport(q: Query, label: string, format: ExportFormat): Promise<Blob> {
  const t = await calendarTable(q, label);
  return format === "csv" ? toCsv(t) : toXlsx(t, "Burning calendar");
}

export async function hotspotsExport(q: Query, label: string, format: ExportFormat): Promise<Blob> {
  const t = await hotspotsTable(q, label);
  return format === "csv" ? toCsv(t) : toXlsx(t, "Hotspots");
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
