// Supporting charts: seasonal profile, annual totals with trend, sensor transparency panel.
import { area, line, max, scaleBand, scaleLinear, scalePoint, scaleSymlog, scaleTime, type ScaleContinuousNumeric } from "d3";
import { useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { MonthRow } from "../api";
import { ChartFrame, LegendItem, Segmented, TipRow, Tooltip, legendWidth, useWidth, type Tip } from "../chart";
import { MONTHS, MONTHS_LONG, SAT_LABEL, T, fmt, fmtAxis, monthLabel, pearson, quantile, theilSen, viirsRaw } from "../lib";

const M = { l: 58, r: 16, t: 30, b: 40 };
const H = 250;

function YAxis({ y, ticks, width, title, mt }: { y: ScaleContinuousNumeric<number, number>; ticks: number[]; width: number; title: string; mt: number }) {
  return (
    <g>
      {ticks.map((t) => (
        <g key={t} transform={`translate(0,${y(t)})`}>
          <line x1={M.l} x2={width - M.r} stroke={T.hairline} strokeWidth={1} />
          <text x={M.l - 8} y={3.5} textAnchor="end" fontFamily={T.mono} fontSize={10.5} fill={T.ink2}>{fmtAxis(t)}</text>
        </g>
      ))}
      <text transform={`translate(12,${(mt + H - M.b) / 2}) rotate(-90)`} textAnchor="middle" fontFamily={T.sans} fontSize={10.5} fill={T.ink2}>
        {title}
      </text>
    </g>
  );
}

function XTitle({ width, children }: { width: number; children: ReactNode }) {
  return (
    <text x={(M.l + width - M.r) / 2} y={H - 6} textAnchor="middle" fontFamily={T.sans} fontSize={10.5} fill={T.ink2}>{children}</text>
  );
}

type LegendSpec = { color: string; dash?: string; label: string; kind?: "line" | "rect" | "band" };

/** Lay legend entries out left to right, wrapping to a new row when the card is narrow. */
function layoutLegend(items: LegendSpec[], width: number) {
  let x = M.l, row = 0;
  const pos = items.map((it) => {
    const w = legendWidth(it.label);
    if (x > M.l && x + w - 18 > width - M.r) {
      x = M.l;
      row += 1;
    }
    const at = { x, y: 10 + row * 17 };
    x += w;
    return at;
  });
  return { items, pos, mt: M.t + row * 17 };
}

function Legend({ layout }: { layout: ReturnType<typeof layoutLegend> }) {
  return <g>{layout.items.map((it, i) => <LegendItem key={it.label} x={layout.pos[i].x} y={layout.pos[i].y} {...it} />)}</g>;
}

/** Index of the nearest x position for a pointer event on the plot. */
function nearest(e: MouseEvent<SVGElement>, xs: number[]): number {
  const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
  let best = 0;
  xs.forEach((x, i) => {
    if (Math.abs(x - px) < Math.abs(xs[best] - px)) best = i;
  });
  return best;
}

interface ChartProps {
  months: MonthRow[];
  unitShort: string;
  footer: string;
}

// ---------------------------------------------------------------- seasonal profile

export function SeasonalProfile({ months, unitShort, footer }: ChartProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [bodyRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const d = useMemo(() => {
    const ok = months.filter((m) => m.harmonized != null);
    const year = ok.length ? Math.max(...ok.map((m) => m.year)) : null;
    const rows = MONTHS.map((_, i) => {
      const v = ok.filter((m) => m.moy === i + 1 && !m.partial).map((m) => m.harmonized!).sort((a, b) => a - b);
      const cur = ok.find((m) => m.year === year && m.moy === i + 1);
      return { moy: i + 1, n: v.length, q25: quantile(v, 0.25), q50: quantile(v, 0.5), q75: quantile(v, 0.75), cur };
    });
    const years = ok.map((m) => m.year);
    return { rows, year, y0: Math.min(...years), y1: Math.max(...years) };
  }, [months]);

  const lg = layoutLegend([
    { color: T.ink2, label: "Median" },
    { color: T.ink2, label: "Interquartile range", kind: "band" },
    { color: T.accent, label: String(d.year ?? "") },
  ], width);
  const mt = lg.mt;
  const x = scalePoint<number>().domain(d.rows.map((r) => r.moy)).range([M.l + 14, width - M.r - 14]);
  const top = max(d.rows, (r) => Math.max(r.n ? r.q75 : 0, r.cur?.harmonized ?? 0)) || 1;
  const y = scaleLinear().domain([0, top]).nice(4).range([H - M.b, mt]);
  const xs = d.rows.map((r) => x(r.moy)!);
  const have = d.rows.filter((r) => r.n > 0);
  const band = area<(typeof d.rows)[number]>().x((r) => x(r.moy)!).y0((r) => y(r.q25)).y1((r) => y(r.q75));
  const med = line<(typeof d.rows)[number]>().x((r) => x(r.moy)!).y((r) => y(r.q50));
  const cur = line<(typeof d.rows)[number]>().defined((r) => r.cur != null).x((r) => x(r.moy)!).y((r) => y(r.cur!.harmonized!));

  const tip: Tip | null = hover == null ? null : {
    x: xs[hover], y: mt + 30,
    content: (
      <>
        <div className="tip-title">{MONTHS_LONG[hover]}</div>
        {d.rows[hover].cur && <TipRow color={T.accent} label={`${d.year}${d.rows[hover].cur!.partial ? " (partial)" : ""}`} value={fmt(d.rows[hover].cur!.harmonized)} />}
        <TipRow color={T.ink2} label="Median" value={fmt(d.rows[hover].q50)} />
        <TipRow label="Interquartile range" value={`${fmt(d.rows[hover].q25)} – ${fmt(d.rows[hover].q75)}`} />
        <div className="tip-note">{d.rows[hover].n} years with a complete month</div>
      </>
    ),
  };

  return (
    <ChartFrame
      title="Seasonal profile" exportName="seasonal-profile" svgRef={svgRef} footer={footer}
      subtitle={`Typical year: median and interquartile range of each calendar month, ${d.y0}–${d.y1}, with ${d.year} drawn on top.`}
    >
      <div ref={bodyRef} className="chart-body">
        {width > 0 && (
          <svg ref={svgRef} width={width} height={H} role="img" aria-label="Seasonal profile chart"
            onMouseMove={(e) => setHover(nearest(e, xs))} onMouseLeave={() => setHover(null)}>
            <Legend layout={lg} />
            <YAxis mt={mt} y={y} ticks={y.ticks(4)} width={width} title={`${unitShort} per month`} />
            {d.rows.map((r) => (
              <text key={r.moy} x={x(r.moy)} y={H - M.b + 15} textAnchor="middle" fontFamily={T.sans} fontSize={10.5} fill={T.ink2}>
                {width < 420 ? MONTHS[r.moy - 1][0] : MONTHS[r.moy - 1]}
              </text>
            ))}
            <XTitle width={width}>Calendar month</XTitle>
            <path d={band(have) ?? ""} fill={T.ink2} opacity={0.2} />
            <path d={med(have) ?? ""} fill="none" stroke={T.ink2} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <path d={cur(d.rows) ?? ""} fill="none" stroke={T.accent} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {d.rows.filter((r) => r.cur).map((r) => (
              <circle key={r.moy} cx={x(r.moy)} cy={y(r.cur!.harmonized!)} r={4}
                fill={r.cur!.partial ? T.surface : T.accent} stroke={r.cur!.partial ? T.accent : T.surface} strokeWidth={2} />
            ))}
            {hover != null && <line x1={xs[hover]} x2={xs[hover]} y1={mt} y2={H - M.b} stroke={T.ink3} strokeWidth={1} />}
          </svg>
        )}
        <Tooltip tip={tip} width={width} />
      </div>
    </ChartFrame>
  );
}

// ---------------------------------------------------------------- annual totals

export function AnnualTotals({ months, unitShort, footer }: ChartProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [bodyRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const d = useMemo(() => {
    const byYear = new Map<number, MonthRow[]>();
    months.forEach((m) => byYear.set(m.year, [...(byYear.get(m.year) ?? []), m]));
    const rows = [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([year, ms]) => {
      const sum = (f: (m: MonthRow) => number | null) => ms.reduce((s, m) => s + (f(m) ?? 0), 0);
      return {
        year, total: sum((m) => m.harmonized), modis: sum((m) => m.modis_raw), viirs: sum(viirsRaw),
        hasViirs: ms.some((m) => viirsRaw(m) != null),
        complete: ms.filter((m) => !m.partial && m.harmonized != null).length === 12, n: ms.length,
      };
    });
    const full = rows.filter((r) => r.complete);
    const fit = theilSen(full.map((r) => r.year), full.map((r) => r.total));
    const mean = full.length ? full.reduce((s, r) => s + r.total, 0) / full.length : 0;
    const switchYear = months.find((m) => m.era === "viirs_transfer")?.year ?? null;
    return { rows, full, fit, mean, switchYear };
  }, [months]);

  const showTrend = !!d.fit && d.full.length >= 5;
  const lg = layoutLegend([
    { color: T.accent, label: "Complete year", kind: "rect" },
    ...(d.rows.some((r) => !r.complete) ? [{ color: "#7a4a2c", label: "Incomplete year (not all 12 months)", kind: "rect" as const }] : []),
    ...(showTrend ? [{ color: T.ink, dash: "5 4", label: "Theil–Sen trend" }] : []),
  ], width);
  const mt = lg.mt;
  const x = scaleBand<number>().domain(d.rows.map((r) => r.year)).range([M.l, width - M.r]).paddingInner(0.25).paddingOuter(0.15);
  const bw = Math.min(24, x.bandwidth());
  const y = scaleLinear().domain([0, max(d.rows, (r) => r.total) || 1]).nice(4).range([H - M.b, mt]);
  const cx = (year: number) => x(year)! + x.bandwidth() / 2;
  const xs = d.rows.map((r) => cx(r.year));
  const every = d.rows.length > 16 ? 5 : d.rows.length > 8 ? 2 : 1;
  const bar = (r: (typeof d.rows)[number]) => {
    const x0 = cx(r.year) - bw / 2, y0 = y(r.total), h = y(0) - y0, rad = Math.min(4, bw / 2, h);
    return `M${x0},${y(0)}V${y0 + rad}Q${x0},${y0} ${x0 + rad},${y0}H${x0 + bw - rad}Q${x0 + bw},${y0} ${x0 + bw},${y0 + rad}V${y(0)}Z`;
  };

  const trendText = showTrend && d.fit
    ? `Trend ${d.fit.slope >= 0 ? "+" : "−"}${fmt(Math.abs(d.fit.slope))} per year (${d.mean ? `${((d.fit.slope / d.mean) * 100).toFixed(1)}% of the mean` : "mean is 0"}), Theil–Sen line over ${d.full.length} complete years; not a significance test.`
    : `A trend line needs at least 5 complete years; this range has ${d.full.length}.`;

  const tip: Tip | null = hover == null ? null : {
    x: xs[hover], y: y(d.rows[hover].total),
    content: (
      <>
        <div className="tip-title">{d.rows[hover].year}</div>
        <TipRow color={T.accent} label="Harmonized total" value={fmt(d.rows[hover].total)} />
        <TipRow color={T.modis} label="Raw MODIS" value={fmt(d.rows[hover].modis)} />
        {d.rows[hover].hasViirs && <TipRow color={T.viirs} dash="4 3" label="Raw VIIRS" value={fmt(d.rows[hover].viirs)} />}
        {!d.rows[hover].complete && <div className="tip-note">Incomplete year ({d.rows[hover].n} months in range) — not used for the trend</div>}
      </>
    ),
  };

  return (
    <ChartFrame title="Year by year" exportName="annual-totals" svgRef={svgRef} footer={footer}
      subtitle={`Harmonized ${unitShort} per calendar year. ${trendText}`}>
      <div ref={bodyRef} className="chart-body">
        {width > 0 && (
          <svg ref={svgRef} width={width} height={H} role="img" aria-label="Annual totals chart"
            onMouseMove={(e) => setHover(nearest(e, xs))} onMouseLeave={() => setHover(null)}>
            <Legend layout={lg} />
            <YAxis mt={mt} y={y} ticks={y.ticks(4)} width={width} title={`${unitShort} per year`} />
            {d.switchYear != null && d.rows[0].year < d.switchYear && (
              <g>
                <line x1={x(d.switchYear)! - (x.step() - x.bandwidth()) / 2} x2={x(d.switchYear)! - (x.step() - x.bandwidth()) / 2}
                  y1={mt} y2={H - M.b} stroke={T.ink3} strokeWidth={1} />
                <text x={x(d.switchYear)! + 2} y={mt + 9} fontFamily={T.sans} fontSize={10} fill={T.ink3}>VIIRS-derived →</text>
              </g>
            )}
            {d.rows.map((r, i) => (
              <g key={r.year}>
                {r.total > 0 && <path d={bar(r)} fill={r.complete ? T.accent : "#7a4a2c"} opacity={hover === i ? 0.8 : 1} />}
                {(r.year % every === 0 || d.rows.length <= 8) && (
                  <text x={cx(r.year)} y={H - M.b + 15} textAnchor="middle" fontFamily={T.mono} fontSize={10.5} fill={T.ink2}>{r.year}</text>
                )}
              </g>
            ))}
            <line x1={M.l} x2={width - M.r} y1={y(0)} y2={y(0)} stroke={T.ink3} strokeWidth={1} />
            {showTrend && d.fit && (
              <line x1={cx(d.full[0].year)} x2={cx(d.full[d.full.length - 1].year)}
                y1={y(Math.max(0, d.fit.intercept + d.fit.slope * d.full[0].year))}
                y2={y(Math.max(0, d.fit.intercept + d.fit.slope * d.full[d.full.length - 1].year))}
                stroke={T.ink} strokeWidth={1.5} strokeDasharray="5 4" strokeLinecap="round" />
            )}
            <XTitle width={width}>Year</XTitle>
          </svg>
        )}
        <Tooltip tip={tip} width={width} />
      </div>
    </ChartFrame>
  );
}

// ---------------------------------------------------------------- sensor transparency

interface SensorProps extends ChartProps {
  agg: "month" | "year";
  onAgg: (a: "month" | "year") => void;
}

export function SensorPanel({ months, unitShort, footer, agg, onAgg }: SensorProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [bodyRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const d = useMemo(() => {
    const ov = months.filter((m) => m.era === "viirs_transfer" && !m.partial && m.harmonized != null && m.modis_raw != null && viirsRaw(m) != null);
    const sum = (rows: MonthRow[], f: (m: MonthRow) => number) => rows.reduce((s, m) => s + f(m), 0);
    const modis = sum(ov, (m) => m.modis_raw!);
    const stats = ov.length >= 3 && modis > 0 ? {
      n: ov.length,
      rawRatio: sum(ov, (m) => viirsRaw(m)!) / modis,
      harmRatio: sum(ov, (m) => m.harmonized!) / modis,
      r: pearson(ov.map((m) => m.harmonized!), ov.map((m) => m.modis_raw!)),
    } : null;
    let pts: { label: string; t: Date; modis: number; viirs: number; harm: number }[];
    if (agg === "month") {
      pts = ov.map((m) => ({ label: monthLabel(m.month), t: new Date(`${m.month}-15`), modis: m.modis_raw!, viirs: viirsRaw(m)!, harm: m.harmonized! }));
    } else {
      const years = [...new Set(ov.map((m) => m.year))].filter((yr) => ov.filter((m) => m.year === yr).length === 12);
      pts = years.map((yr) => {
        const rows = ov.filter((m) => m.year === yr);
        return { label: String(yr), t: new Date(`${yr}-07-01`), modis: sum(rows, (m) => m.modis_raw!), viirs: sum(rows, (m) => viirsRaw(m)!), harm: sum(rows, (m) => m.harmonized!) };
      });
    }
    const sats = [...new Set(ov.map((m) => SAT_LABEL[m.source] ?? m.source))];
    return { pts, stats, sats };
  }, [months, agg]);

  const viirsName = d.sats.length ? `Raw ${d.sats.join(" / ")}` : "Raw VIIRS";
  const lg = layoutLegend([
    { color: T.viirs, dash: "2 4", label: viirsName },
    { color: T.modis, label: "Raw MODIS" },
    { color: T.accent, dash: "7 4", label: "Harmonized" },
  ], width);
  const mt = lg.mt;
  const top = max(d.pts, (p) => Math.max(p.modis, p.viirs, p.harm)) || 1;
  const x = scaleTime().domain(d.pts.length ? [d.pts[0].t, d.pts[d.pts.length - 1].t] : [new Date(), new Date()]).range([M.l + 6, width - M.r - 6]);
  const y = agg === "month"
    ? scaleSymlog().constant(1).domain([0, top]).range([H - M.b, mt])
    : scaleLinear().domain([0, top]).nice(4).range([H - M.b, mt]);
  const yTicks = agg === "month" ? [0, 1, 10, 100, 1000, 10000, 100000, 1000000].filter((v) => v <= top) : (y as ReturnType<typeof scaleLinear>).ticks(4);
  const xs = d.pts.map((p) => x(p.t));
  const path = (f: (p: (typeof d.pts)[number]) => number) =>
    line<(typeof d.pts)[number]>().x((p) => x(p.t)).y((p) => y(f(p)))(d.pts) ?? "";

  const subtitle = d.stats
    ? `Sensor overlap, ${d.stats.n} complete months: raw VIIRS totals ${d.stats.rawRatio.toFixed(2)}× MODIS; after harmonization ${d.stats.harmRatio.toFixed(2)}× (monthly correlation r = ${d.stats.r.toFixed(3)}). The closer the dashed orange line sits on the blue line, the better the conversion.`
    : "Raw MODIS, raw VIIRS and the harmonized series over the months where both sensors observed.";

  const tip: Tip | null = hover == null || !d.pts[hover] ? null : {
    x: xs[hover], y: mt + 30,
    content: (
      <>
        <div className="tip-title">{d.pts[hover].label}</div>
        <TipRow color={T.accent} dash="7 4" label="Harmonized" value={fmt(d.pts[hover].harm)} />
        <TipRow color={T.modis} label="Raw MODIS" value={fmt(d.pts[hover].modis)} />
        <TipRow color={T.viirs} dash="2 4" label={viirsName} value={fmt(d.pts[hover].viirs)} />
      </>
    ),
  };

  return (
    <ChartFrame title="MODIS vs VIIRS" exportName="modis-vs-viirs" svgRef={svgRef} subtitle={subtitle}
      footer={`${footer} The conversion was fitted on these months; tests on held-out years are in VALIDATION.md in the project repository.`}
      controls={<Segmented label="Aggregation" value={agg} onChange={onAgg}
        options={[{ value: "month", label: "Monthly" }, { value: "year", label: "Annual" }]} />}>
      <div ref={bodyRef} className="chart-body">
        {d.pts.length < 2 ? (
          <p className="empty">No {agg === "year" ? "complete overlap years" : "sensor overlap"} in this date range. Choose a longer period to compare the sensors.</p>
        ) : width > 0 && (
          <svg ref={svgRef} width={width} height={H} role="img" aria-label="Sensor transparency chart"
            onMouseMove={(e) => setHover(nearest(e, xs))} onMouseLeave={() => setHover(null)}>
            <Legend layout={lg} />
            <YAxis mt={mt} y={y} ticks={yTicks} width={width} title={`${unitShort} per ${agg}${agg === "month" ? " (log scale)" : ""}`} />
            {x.ticks(Math.max(2, Math.floor(width / 90))).map((t) => (
              <text key={+t} x={x(t)} y={H - M.b + 15} textAnchor="middle" fontFamily={T.mono} fontSize={10.5} fill={T.ink2}>{t.getFullYear()}</text>
            ))}
            <XTitle width={width}>{agg === "month" ? "Month (UTC acquisition date)" : "Year"}</XTitle>
            <path d={path((p) => p.viirs)} fill="none" stroke={T.viirs} strokeWidth={1.75} strokeDasharray="2 4" strokeLinecap="round" strokeLinejoin="round" />
            <path d={path((p) => p.modis)} fill="none" stroke={T.modis} strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" />
            <path d={path((p) => p.harm)} fill="none" stroke={T.accent} strokeWidth={2} strokeDasharray="7 4" strokeLinejoin="round" />
            {hover != null && d.pts[hover] && (
              <g>
                <line x1={xs[hover]} x2={xs[hover]} y1={mt} y2={H - M.b} stroke={T.ink3} strokeWidth={1} />
                {([["viirs", T.viirs], ["modis", T.modis], ["harm", T.accent]] as const).map(([k, c]) => (
                  <circle key={k} cx={xs[hover]} cy={y(d.pts[hover][k])} r={4} fill={c} stroke={T.surface} strokeWidth={2} />
                ))}
              </g>
            )}
          </svg>
        )}
        <Tooltip tip={tip} width={width} />
      </div>
    </ChartFrame>
  );
}
