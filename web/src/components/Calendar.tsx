// The burning calendar: years as rows, months as columns. Value mode or anomaly mode.
import { useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { MonthRow } from "../api";
import { ChartFrame, Segmented, TipRow, Tooltip, useWidth, type Tip } from "../chart";
import {
  ANOMALY_CLAMP, MONTHS, SAT_LABEL, T, anomalyScore, diverging, eraLabel, fmt, fmtPct, inferno,
  makeValueScale, monthLabel, monthlyMedians,
} from "../lib";

interface Props {
  months: MonthRow[];
  mode: "value" | "anomaly";
  scale: "log" | "quantile";
  unit: string;
  footer: string;
  onMode: (m: "value" | "anomaly") => void;
  onScale: (s: "log" | "quantile") => void;
}

const LEFT = 42, TOP = 20, ROW = 20, GAP = 2, LEGEND_H = 78;

export function MonthTip({ m, med }: { m: MonthRow; med: number | null }) {
  const h = m.harmonized;
  const departure = h != null && med != null && med > 0 ? ((h - med) / med) * 100 : null;
  return (
    <>
      <div className="tip-title">{monthLabel(m.month)}</div>
      <TipRow color={T.accent} label="Harmonized" value={fmt(h)} />
      {h != null && m.lo != null && m.hi != null && m.lo !== m.hi && (
        <TipRow label="5–95 % band" value={`${fmt(m.lo)} – ${fmt(m.hi)}`} />
      )}
      <TipRow color={T.modis} label="Raw MODIS" value={fmt(m.modis_raw)} />
      {(["viirs_snpp", "viirs_n20", "viirs_n21"] as const).map((s) =>
        m[`${s}_raw`] != null ? (
          <TipRow key={s} color={T.viirs} dash="4 3" label={`Raw ${SAT_LABEL[s]}`} value={fmt(m[`${s}_raw`])} />
        ) : null,
      )}
      {med != null && (
        <TipRow label={`${MONTHS[m.moy - 1]} median`} value={`${fmt(med)}${departure != null ? `  (${fmtPct(departure)})` : ""}`} />
      )}
      <div className="tip-note">{eraLabel(m)}</div>
      {m.partial && <div className="tip-note">Partial month: {m.days_observed} of {m.days_in_month} days observed</div>}
      {h == null && <div className="tip-note">No transfer could be fitted for this month</div>}
    </>
  );
}

export function Calendar({ months, mode, scale, unit, footer, onMode, onScale }: Props) {
  const uid = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [bodyRef, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<{ yi: number; mi: number } | null>(null);

  const { years, byKey, medians, vscale } = useMemo(() => {
    const ys = months.map((m) => m.year);
    const years = ys.length ? Array.from({ length: Math.max(...ys) - Math.min(...ys) + 1 }, (_, i) => Math.min(...ys) + i) : [];
    const byKey = new Map(months.map((m) => [`${m.year}-${m.moy}`, m]));
    const medians = monthlyMedians(months);
    const vscale = makeValueScale(months.filter((m) => m.harmonized != null).map((m) => m.harmonized!), scale);
    return { years, byKey, medians, vscale };
  }, [months, scale]);

  const cw = Math.max(8, (width - LEFT - 6) / 12);
  const gridH = years.length * ROW;
  const narrow = width - LEFT < 330; // the third legend mark drops to its own line on phones
  const height = TOP + gridH + LEGEND_H + (narrow ? 18 : 0);
  const cell = (yi: number, mi: number) => byKey.get(`${years[yi]}-${mi + 1}`);

  const fill = (m: MonthRow): string => {
    if (m.harmonized == null) return "none";
    if (mode === "value") return vscale.color(m.harmonized);
    const med = medians[m.moy];
    return med == null ? "none" : diverging(anomalyScore(m.harmonized, med) / ANOMALY_CLAMP);
  };

  const tip: Tip | null = (() => {
    if (!active) return null;
    const m = cell(active.yi, active.mi);
    if (!m) return null;
    return { x: LEFT + active.mi * cw + cw / 2, y: TOP + active.yi * ROW, content: <MonthTip m={m} med={medians[m.moy]} /> };
  })();

  const onKey = (e: KeyboardEvent) => {
    const step: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (e.key === "Escape") return setActive(null);
    if (!step[e.key] || !years.length) return;
    e.preventDefault();
    const cur = active ?? { yi: years.length - 1, mi: 0 };
    setActive({
      yi: Math.max(0, Math.min(years.length - 1, cur.yi + step[e.key][0])),
      mi: Math.max(0, Math.min(11, cur.mi + step[e.key][1])),
    });
  };

  // One handler for the whole grid: the pointer only has to be over a cell's slot, gaps included.
  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const mi = Math.floor((e.clientX - box.left - LEFT) / cw);
    const yi = Math.floor((e.clientY - box.top - TOP) / ROW);
    if (mi < 0 || mi > 11 || yi < 0 || yi >= years.length || !cell(yi, mi)) return setActive(null);
    if (!active || active.yi !== yi || active.mi !== mi) setActive({ yi, mi });
  };

  // ---- legend geometry
  const ly = TOP + gridH + 16;
  const rampW = Math.min(mode === "value" ? 220 : 300, Math.max(120, width - LEFT - 80));
  const logTicks = [1, 10, 100, 1000, 10000, 100000].filter((v) => v <= vscale.max);
  const anomTicks = ([[-3, "−88%"], [-1, "−50%"], [0, "median"], [1, "+100%"], [3, "+700%"]] as [number, string][])
    .filter(([s]) => rampW >= 260 || Math.abs(s) !== 1);

  const title = mode === "value" ? "Burning calendar" : "Burning calendar — anomaly";
  const subtitle =
    mode === "value"
      ? `${unit}, by month. ${vscale.kind === "log" ? "Logarithmic colour scale." : "Quantile colour scale: seven classes with equal numbers of months."}`
      : "Departure of each month from the multi-year median of the same calendar month, over the months shown. Orange = more burning than usual, purple = less.";

  return (
    <ChartFrame
      hero title={title} subtitle={subtitle} footer={footer} exportName={`burning-calendar-${mode}`} svgRef={svgRef}
      controls={
        <>
          <Segmented label="Calendar mode" value={mode} onChange={onMode}
            options={[{ value: "value", label: "Value" }, { value: "anomaly", label: "Anomaly" }]} />
          {mode === "value" && (
            <Segmented label="Colour scale" value={scale} onChange={onScale}
              options={[{ value: "log", label: "Log" }, { value: "quantile", label: "Quantile" }]} />
          )}
        </>
      }
    >
      <div
        ref={bodyRef} className="chart-body" tabIndex={0} onKeyDown={onKey} onBlur={() => setActive(null)}
        onFocus={() => !active && years.length && setActive({ yi: years.length - 1, mi: 0 })}
        aria-label={`${title}. ${years.length} years by 12 months. Use the arrow keys to read each month.`}
      >
        {width > 0 && (
          <svg ref={svgRef} width={width} height={height} role="img" aria-hidden="true" onMouseMove={onMove} onMouseLeave={() => setActive(null)}>
            <defs>
              {/* Two-tone hatches stay visible on both the darkest and the brightest cells. */}
              <pattern id={`${uid}-partial`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="1" y1="0" x2="1" y2="6" stroke="#000" strokeOpacity="0.6" strokeWidth="1.6" />
                <line x1="2.6" y1="0" x2="2.6" y2="6" stroke="#fff" strokeOpacity="0.85" strokeWidth="1.4" />
              </pattern>
              <pattern id={`${uid}-terra`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
                <line x1="1" y1="0" x2="1" y2="5" stroke="#000" strokeOpacity="0.55" strokeWidth="1.2" />
                <line x1="2.2" y1="0" x2="2.2" y2="5" stroke="#fff" strokeOpacity="0.7" strokeWidth="0.9" />
              </pattern>
              <linearGradient id={`${uid}-ramp`}>
                {Array.from({ length: 11 }, (_, i) => (
                  <stop key={i} offset={`${i * 10}%`} stopColor={mode === "value" ? inferno(i / 10) : diverging(i / 5 - 1)} />
                ))}
              </linearGradient>
            </defs>

            {MONTHS.map((name, mi) => (
              <text key={name} x={LEFT + mi * cw + (cw - GAP) / 2} y={12} textAnchor="middle" fontFamily={T.sans} fontSize={10.5} fill={T.ink2}>
                {cw < 30 ? name[0] : name}
              </text>
            ))}
            {years.map((year, yi) => (
              <g key={year}>
                <text x={LEFT - 8} y={TOP + yi * ROW + ROW / 2 + 2.5} textAnchor="end" fontFamily={T.mono} fontSize={10.5} fill={T.ink2}>
                  {year}
                </text>
                {MONTHS.map((_, mi) => {
                  const m = cell(yi, mi);
                  const x = LEFT + mi * cw, y = TOP + yi * ROW, w = cw - GAP, h = ROW - GAP;
                  if (!m) return null;
                  const f = fill(m);
                  return (
                    <g key={mi}>
                      <rect x={x} y={y} width={w} height={h} rx={2} fill={f} stroke={f === "none" ? T.hairline : "none"} />
                      {m.terra_only && <rect x={x} y={y} width={w} height={h} rx={2} fill={`url(#${uid}-terra)`} />}
                      {m.partial && <rect x={x} y={y} width={w} height={h} rx={2} fill={`url(#${uid}-partial)`} />}
                    </g>
                  );
                })}
              </g>
            ))}
            {active && cell(active.yi, active.mi) && (
              <rect x={LEFT + active.mi * cw - 1} y={TOP + active.yi * ROW - 1} width={cw} height={ROW} rx={3}
                fill="none" stroke={T.ink} strokeWidth={1.5} pointerEvents="none" />
            )}

            {/* legend: colour scale */}
            <g transform={`translate(${LEFT},${ly})`} fontFamily={T.sans} fontSize={10.5} fill={T.ink2}>
              {mode === "value" && (
                <>
                  <rect x={0} y={0} width={14} height={9} rx={2} fill={T.zero} />
                  <text x={7} y={23} textAnchor="middle" fontFamily={T.mono}>0</text>
                </>
              )}
              {mode === "value" && vscale.kind === "quantile" ? (
                vscale.classes.map((c, i) => (
                  <g key={i} transform={`translate(${24 + i * 30},0)`}>
                    <rect width={28} height={9} rx={2} fill={c} />
                    {i > 0 && <text x={-1} y={23} textAnchor="middle" fontFamily={T.mono}>{fmt(vscale.breaks[i - 1])}</text>}
                  </g>
                ))
              ) : (
                <g transform={`translate(${mode === "value" ? 24 : 0},0)`}>
                  <rect width={rampW} height={9} rx={2} fill={`url(#${uid}-ramp)`} />
                  {mode === "value"
                    ? logTicks.map((v) => {
                        const x = (Math.log1p(v) / Math.log1p(vscale.max)) * rampW;
                        return <text key={v} x={x} y={23} textAnchor="middle" fontFamily={T.mono}>{fmt(v)}</text>;
                      })
                    : anomTicks.map(([s, label]) => (
                        <text key={s} x={((s + ANOMALY_CLAMP) / (2 * ANOMALY_CLAMP)) * rampW} y={23}
                          textAnchor={s === -3 ? "start" : s === 3 ? "end" : "middle"} fontFamily={T.mono}>{label}</text>
                      ))}
                </g>
              )}
              {/* legend: marks */}
              <g transform="translate(0,40)">
                <rect width={16} height={11} rx={2} fill={T.raised} />
                <rect width={16} height={11} rx={2} fill={`url(#${uid}-partial)`} />
                <text x={22} y={9.5}>partial month</text>
                <rect x={112} width={16} height={11} rx={2} fill={T.raised} />
                <rect x={112} width={16} height={11} rx={2} fill={`url(#${uid}-terra)`} />
                <text x={134} y={9.5}>Terra-only, scaled</text>
                <g transform={narrow ? "translate(0,18)" : "translate(250,0)"}>
                  <rect x={0.5} y={0.5} width={15} height={10} rx={2} fill="none" stroke={T.hairline} />
                  <text x={22} y={9.5}>no data</text>
                </g>
              </g>
            </g>
          </svg>
        )}
        <Tooltip tip={tip} width={width} />
      </div>
    </ChartFrame>
  );
}
