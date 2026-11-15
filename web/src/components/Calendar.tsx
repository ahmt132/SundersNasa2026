// The burning calendar: years as rows, months as columns. Each square is one month; its colour (and,
// when there is room, the number printed in it) says how much burned. "Fire activity" shows the
// harmonized amount; "Compared with usual" shows how far each month is above or below the median
// of the same calendar month in the other years.
import { useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { MonthRow } from "../api";
import { ChartFrame, Segmented, TipRow, Tooltip, useWidth, type Tip } from "../chart";
import {
  ANOMALY_CLAMP, MONTHS, MONTHS_LONG, SAT_LABEL, T, anomalyScore, diverging, eraLabel, fmt, fmtCompact, fmtPct,
  makeValueScale, monthLabel, monthlyMedians, rampColor, textOn,
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

const LEFT = 42, TOP = 20, GAP = 3;

function MonthTip({ m, med }: { m: MonthRow; med: number | null }) {
  const h = m.harmonized;
  const departure = h != null && med != null && med > 0 ? ((h - med) / med) * 100 : null;
  return (
    <>
      <div className="tip-title">{monthLabel(m.month)}</div>
      <TipRow color={T.accent} label="Fire activity (harmonized)" value={fmt(h)} />
      {h != null && m.lo != null && m.hi != null && m.lo !== m.hi && (
        <TipRow label="Likely range (5–95 %)" value={`${fmt(m.lo)} – ${fmt(m.hi)}`} />
      )}
      <TipRow color={T.modis} label="Raw MODIS" value={fmt(m.modis_raw)} />
      {(["viirs_snpp", "viirs_n20", "viirs_n21"] as const).map((s) =>
        m[`${s}_raw`] != null ? (
          <TipRow key={s} color={T.viirs} dash="4 3" label={`Raw ${SAT_LABEL[s]}`} value={fmt(m[`${s}_raw`])} />
        ) : null,
      )}
      {med != null && (
        <TipRow label={`Usual ${MONTHS_LONG[m.moy - 1]} (median)`} value={`${fmt(med)}${departure != null ? `  (${fmtPct(departure)})` : ""}`} />
      )}
      <div className="tip-note">{eraLabel(m)}</div>
      {m.partial && <div className="tip-note">Partial month: {m.days_observed} of {m.days_in_month} days observed</div>}
      {h == null && <div className="tip-note">No conversion could be fitted for this month</div>}
    </>
  );
}

export function Calendar({ months, mode, scale, unit, footer, onMode, onScale }: Props) {
  const uid = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [bodyRef, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<{ yi: number; mi: number } | null>(null);

  const { years, byKey, medians, vscale, marks } = useMemo(() => {
    const ys = months.map((m) => m.year);
    const years = ys.length ? Array.from({ length: Math.max(...ys) - Math.min(...ys) + 1 }, (_, i) => Math.min(...ys) + i) : [];
    const byKey = new Map(months.map((m) => [`${m.year}-${m.moy}`, m]));
    const medians = monthlyMedians(months);
    const vscale = makeValueScale(months.filter((m) => m.harmonized != null).map((m) => m.harmonized!), scale);
    // legend marks are shown only when they occur in the months on screen
    const marks = {
      partial: months.some((m) => m.partial),
      terra: months.some((m) => m.terra_only),
      none: months.some((m) => m.harmonized == null),
    };
    return { years, byKey, medians, vscale, marks };
  }, [months, scale]);

  const cw = Math.max(8, (width - LEFT - 6) / 12);
  const showNumbers = cw >= 36; // room for "12.3k" inside the square
  const ROW = showNumbers ? Math.min(34, Math.max(26, cw * 0.45)) : 20;
  const gridH = years.length * ROW;
  const cell = (yi: number, mi: number) => byKey.get(`${years[yi]}-${mi + 1}`);
  const markList = [
    marks.partial && { key: "partial", label: "partial month (not all days observed)" },
    marks.terra && { key: "terra", label: "Terra only, scaled" },
    marks.none && { key: "none", label: "no data" },
  ].filter(Boolean) as { key: string; label: string }[];
  const LEGEND_H = 48 + (markList.length ? 26 : 0);
  const height = TOP + gridH + LEGEND_H;

  const departure = (m: MonthRow) => {
    const med = medians[m.moy];
    return m.harmonized == null || med == null || med <= 0 ? null : ((m.harmonized - med) / med) * 100;
  };
  const fill = (m: MonthRow): string => {
    if (m.harmonized == null) return "none";
    if (mode === "value") return vscale.color(m.harmonized);
    const med = medians[m.moy];
    return med == null ? "none" : diverging(anomalyScore(m.harmonized, med) / ANOMALY_CLAMP);
  };
  const label = (m: MonthRow): string => {
    if (m.harmonized == null) return "";
    if (mode === "value") return fmtCompact(m.harmonized);
    const d = departure(m);
    return d == null ? "" : `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d) >= 1000 ? fmtCompact(Math.abs(d)) : Math.round(Math.abs(d))}%`;
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
  const ly = TOP + gridH + 14;
  const rampW = Math.min(360, Math.max(140, width - LEFT - 120));
  const valueTicks = (() => {
    // powers of ten inside the range, plus the two ends
    const out: number[] = [];
    for (let p = 1; p <= 1e7; p *= 10) if (p > vscale.min * 1.5 && p < vscale.max / 1.5) out.push(p);
    return [vscale.min, ...out, vscale.max];
  })();
  const qStep = Math.max(30, Math.min(52, (width - LEFT - 40) / 7));
  const anomTicks = ([[-3, "8× less"], [-1, "half"], [0, "usual"], [1, "double"], [3, "8× more"]] as [number, string][])
    .filter(([s]) => rampW >= 260 || Math.abs(s) !== 1);

  const title = mode === "value" ? "Burning calendar" : "Burning calendar — compared with usual";
  const subtitle =
    mode === "value"
      ? `Each square is one month: brighter = more fire. The number is the month's fire activity in ${unit.replace(" per month", "")}.`
      : "Each square compares a month with the same month in the other years: orange = more fire than usual, purple = less. The number is the difference.";

  return (
    <ChartFrame
      hero title={title} subtitle={subtitle} footer={footer} exportName={`burning-calendar-${mode}`} svgRef={svgRef}
      controls={
        <>
          <Segmented label="Calendar mode" value={mode} onChange={onMode}
            options={[{ value: "value", label: "Fire activity" }, { value: "anomaly", label: "Compared with usual" }]} />
          {mode === "value" && (
            <Segmented label="Colour steps" value={scale} onChange={onScale}
              options={[{ value: "log", label: "Gradual" }, { value: "quantile", label: "7 ranked groups" }]} />
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
                <line x1="1" y1="0" x2="1" y2="6" stroke="#000" strokeOpacity="0.45" strokeWidth="1.4" />
                <line x1="2.6" y1="0" x2="2.6" y2="6" stroke="#fff" strokeOpacity="0.6" strokeWidth="1.2" />
              </pattern>
              <pattern id={`${uid}-terra`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
                <line x1="1" y1="0" x2="1" y2="5" stroke="#000" strokeOpacity="0.55" strokeWidth="1.2" />
                <line x1="2.2" y1="0" x2="2.2" y2="5" stroke="#fff" strokeOpacity="0.7" strokeWidth="0.9" />
              </pattern>
              <linearGradient id={`${uid}-ramp`}>
                {Array.from({ length: 11 }, (_, i) => (
                  <stop key={i} offset={`${i * 10}%`} stopColor={mode === "value" ? rampColor(i / 10) : diverging(i / 5 - 1)} />
                ))}
              </linearGradient>
            </defs>

            {MONTHS.map((name, mi) => (
              <text key={name} x={LEFT + mi * cw + (cw - GAP) / 2} y={12} textAnchor="middle" fontFamily={T.sans} fontSize={12} fill={T.ink2}>
                {cw < 30 ? name[0] : name}
              </text>
            ))}
            {years.map((year, yi) => (
              <g key={year}>
                <text x={LEFT - 8} y={TOP + yi * ROW + ROW / 2 + 4} textAnchor="end" fontFamily={T.mono} fontSize={12} fill={T.ink2}>
                  {year}
                </text>
                {MONTHS.map((_, mi) => {
                  const m = cell(yi, mi);
                  const x = LEFT + mi * cw, y = TOP + yi * ROW, w = cw - GAP, h = ROW - GAP;
                  if (!m) return null;
                  const f = fill(m);
                  const text = showNumbers ? label(m) : "";
                  return (
                    <g key={mi}>
                      <rect x={x} y={y} width={w} height={h} rx={3} fill={f} stroke={f === "none" ? T.hairline : "none"} />
                      {m.terra_only && <rect x={x} y={y} width={w} height={h} rx={3} fill={`url(#${uid}-terra)`} />}
                      {m.partial && <rect x={x} y={y} width={w} height={h} rx={3} fill={`url(#${uid}-partial)`} />}
                      {text && (
                        <text x={x + w / 2} y={y + h / 2 + 4} textAnchor="middle" fontFamily={T.sans} fontSize={cw >= 52 ? 13 : 11.5}
                          fontWeight={600} fill={f === "none" ? T.ink2 : textOn(f)} pointerEvents="none"
                          paintOrder="stroke" stroke={m.partial ? (f === "none" ? T.surface : f) : "none"} strokeWidth={3}>
                          {text}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            ))}
            {active && cell(active.yi, active.mi) && (
              <rect x={LEFT + active.mi * cw - 1.5} y={TOP + active.yi * ROW - 1.5} width={cw - GAP + 3} height={ROW - GAP + 3} rx={4}
                fill="none" stroke={T.ink} strokeWidth={2} pointerEvents="none" />
            )}

            {/* legend: colour scale, with plain words at both ends */}
            <g transform={`translate(${LEFT},${ly})`} fontFamily={T.sans} fontSize={12} fill={T.ink2}>
              {mode === "value" && vscale.kind === "quantile" ? (
                <>
                  {vscale.classes.map((c, i) => (
                    <g key={i} transform={`translate(${i * qStep},0)`}>
                      <rect width={qStep - 2} height={10} rx={2} fill={c} />
                      {i > 0 && <text x={-1} y={25} textAnchor="middle" fontFamily={T.mono}>{fmtCompact(vscale.breaks[i - 1])}</text>}
                    </g>
                  ))}
                  <text x={7 * qStep + 8} y={9}>each colour holds one seventh of the months</text>
                </>
              ) : (
                <>
                  <text x={0} y={9}>{mode === "value" ? "less fire" : "less than usual"}</text>
                  <g transform="translate(90,0)">
                    <rect width={rampW} height={10} rx={2} fill={`url(#${uid}-ramp)`} />
                    {mode === "value"
                      ? valueTicks.map((v, i) => (
                          <text key={`${v}-${i}`} x={vscale.pos(v) * rampW} y={25}
                            textAnchor={i === 0 ? "start" : i === valueTicks.length - 1 ? "end" : "middle"} fontFamily={T.mono}>{fmtCompact(v)}</text>
                        ))
                      : anomTicks.map(([s, lab]) => (
                          <text key={s} x={((s + ANOMALY_CLAMP) / (2 * ANOMALY_CLAMP)) * rampW} y={25}
                            textAnchor={s === -3 ? "start" : s === 3 ? "end" : "middle"} fontFamily={T.mono}>{lab}</text>
                        ))}
                    <text x={rampW + 10} y={9}>{mode === "value" ? "more fire" : "more than usual"}</text>
                  </g>
                </>
              )}
              {/* legend: marks that occur in these months */}
              {markList.length > 0 && (
                <g transform="translate(0,42)">
                  {markList.map((mk, i) => {
                    const x = i * 230;
                    return (
                      <g key={mk.key} transform={`translate(${x},0)`}>
                        {mk.key === "none"
                          ? <rect x={0.5} y={0.5} width={15} height={11} rx={2} fill="none" stroke={T.hairline} />
                          : <>
                              <rect width={16} height={12} rx={2} fill={T.raised} />
                              <rect width={16} height={12} rx={2} fill={`url(#${uid}-${mk.key})`} />
                            </>}
                        <text x={22} y={10}>{mk.label}</text>
                      </g>
                    );
                  })}
                </g>
              )}
            </g>
          </svg>
        )}
        <Tooltip tip={tip} width={width} />
      </div>
    </ChartFrame>
  );
}
