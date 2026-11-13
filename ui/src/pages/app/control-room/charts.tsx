/**
 * Control room charts (po-1186 CR2): inline SVG drawn at the container's real
 * pixel width, so labels stay 14px on a phone and on a wide screen (a scaled
 * viewBox shrank them to ~7px in the prototype's first pass). Grey + the one
 * accent, no animation, a <title> per mark for hover and screen readers.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { fmtDay } from "../../../lib/control-room-overview";

/** The element's width in CSS pixels, kept current on resize. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => setW(Math.floor(el.clientWidth));
    set();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const LABEL = "fill-muted-foreground text-[14px]";

/** Round the top tick up to a friendly step. */
function niceTop(max: number): { top: number; step: number } {
  const raw = Math.max(4, max) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  return { top: step * 4, step };
}

export function StackedBars({
  days,
  series,
  height = 200,
  label,
}: {
  days: string[];
  /** Bottom-up. `tone`: "grey" or "accent". */
  series: Array<{ label: string; tone: "grey" | "accent"; values: number[] }>;
  height?: number;
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const W = Math.max(260, width);
  const h = height;
  const padL = 36;
  const padB = 28;
  const padT = 8;
  const n = Math.max(1, days.length);
  const totals = days.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const { top, step } = niceTop(Math.max(0, ...totals));
  const slot = (W - padL) / n;
  const bw = Math.max(2, slot * 0.62);
  // Keep x labels ≥ ~44px apart at 14px.
  const every = Math.max(1, Math.ceil(44 / slot));
  const plotH = h - padT - padB;
  return (
    <div ref={ref} className="w-full min-w-0" style={{ minHeight: h }}>
      {width > 0 && (
        <svg width={W} height={h} viewBox={`0 0 ${W} ${h}`} role="img" aria-label={label} className="block max-w-full">
          {[0, 1, 2, 3, 4].map((t) => {
            const y = padT + plotH * (1 - t / 4);
            return (
              <g key={t}>
                <line x1={padL} x2={W} y1={y} y2={y} className="stroke-border" strokeWidth={1} />
                <text x={padL - 8} y={y + 5} textAnchor="end" className={LABEL}>
                  {Math.round(t * step)}
                </text>
              </g>
            );
          })}
          {days.map((d, i) => {
            const x = padL + slot * i + (slot - bw) / 2;
            let y0 = h - padB;
            return (
              <g key={d}>
                {series.map((s) => {
                  const v = s.values[i] ?? 0;
                  if (!v) return null;
                  const bh = (plotH * v) / top;
                  y0 -= bh;
                  return (
                    <rect key={s.label} x={x} y={y0} width={bw} height={bh} rx={1.5} className={s.tone === "accent" ? "fill-primary" : "fill-zinc-300"}>
                      <title>{`${fmtDay(d)} · ${s.label}: ${v}`}</title>
                    </rect>
                  );
                })}
                {(n - 1 - i) % every === 0 && (
                  <text
                    x={x + bw / 2 + 24 > W ? W - 1 : x + bw / 2}
                    y={h - 6}
                    textAnchor={x + bw / 2 + 24 > W ? "end" : "middle"}
                    className={LABEL}
                  >
                    {i === 0 || d.endsWith("-01") || every > 1 ? fmtDay(d) : fmtDay(d).replace(/^[A-Za-z]+ /, "")}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

export function CumulativeLine({ points, height = 140, label }: { points: Array<{ day: string; value: number }>; height?: number; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const W = Math.max(240, width);
  const h = height;
  const padL = 30;
  const padB = 26;
  const padT = 10;
  const n = points.length;
  const max = Math.max(4, ...points.map((p) => p.value));
  const { top } = niceTop(max);
  const x = (i: number) => (n <= 1 ? padL : padL + ((W - padL - 8) * i) / (n - 1));
  const y = (v: number) => padT + (h - padT - padB) * (1 - v / top);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  const last = points[n - 1];
  return (
    <div ref={ref} className="w-full min-w-0" style={{ minHeight: h }}>
      {width > 0 && n > 0 && (
        <svg width={W} height={h} viewBox={`0 0 ${W} ${h}`} role="img" aria-label={label} className="block max-w-full">
          <line x1={padL} x2={W} y1={y(0)} y2={y(0)} className="stroke-border" />
          <line x1={padL} x2={W} y1={y(top)} y2={y(top)} className="stroke-border" />
          <text x={padL - 6} y={y(top) + 5} textAnchor="end" className={LABEL}>
            {top}
          </text>
          <text x={padL - 6} y={y(0) + 5} textAnchor="end" className={LABEL}>
            0
          </text>
          <path d={d} fill="none" className="stroke-primary" strokeWidth={2} />
          <circle cx={x(n - 1)} cy={y(last.value)} r={3.5} className="fill-primary">
            <title>{`${fmtDay(last.day)}: ${last.value}`}</title>
          </circle>
          <text x={padL} y={h - 6} className={LABEL}>
            {fmtDay(points[0].day)}
          </text>
          {n > 1 && (
            <text x={W - 4} y={h - 6} textAnchor="end" className={LABEL}>
              {fmtDay(last.day)}
            </text>
          )}
        </svg>
      )}
    </div>
  );
}
