"use client";

import { cn } from "@/utils/classname";
import { ReactNode } from "react";

/** Dependency-free SVG charts — no client-side data processing beyond simple scales. */

export function StatCard({
  label,
  value,
  sub,
  tone = "slate",
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "slate" | "green" | "red" | "blue" | "amber" | "purple";
  icon?: ReactNode;
}) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-600",
    green: "bg-green-100 text-green-700",
    red: "bg-red-100 text-red-700",
    blue: "bg-blue-100 text-blue-700",
    amber: "bg-amber-100 text-amber-700",
    purple: "bg-purple-100 text-purple-700",
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
        {icon && <div className={cn("flex h-7 w-7 items-center justify-center rounded-lg text-xs", tones[tone])}>{icon}</div>}
      </div>
      <p className="mt-1.5 truncate text-xl font-bold text-slate-900">{value}</p>
      {sub && <p className="mt-0.5 truncate text-xs text-slate-400">{sub}</p>}
    </div>
  );
}

export function BarChart({ data, height = 180, color = "#2563eb", valueFormat }: {
  data: Array<{ label: string; value: number }>;
  height?: number;
  color?: string;
  valueFormat?: (v: number) => string;
}) {
  if (data.length === 0) {
    return <div className="flex h-40 items-center justify-center text-sm text-slate-400">No data for this range</div>;
  }
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1);
  // Render as flex columns with height % — responsive without measuring
  return (
    <div className="w-full" style={{ height }}>
      <div className="flex h-full items-end gap-1">
        {data.map((d, i) => (
          <div key={i} className="group relative flex h-full flex-1 flex-col items-center justify-end">
            <div
              className="w-full max-w-10 rounded-t transition-all group-hover:opacity-80"
              style={{ height: `${Math.max(2, (Math.abs(d.value) / max) * 100)}%`, backgroundColor: color }}
              title={`${d.label}: ${valueFormat ? valueFormat(d.value) : d.value.toLocaleString()}`}
            />
            <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-900 px-2 py-1 text-xs text-white group-hover:block">
              {valueFormat ? valueFormat(d.value) : d.value.toLocaleString()}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1 text-[10px] text-slate-400">
        {data.slice(0, 12).map((d, i) => (
          <span key={i} className="flex-1 truncate text-center">{d.label.slice(-2)}</span>
        ))}
      </div>
    </div>
  );
}

export function LineChart({ data, height = 200, color = "#2563eb", secondary, secondaryColor = "#ef4444", valueFormat }: {
  data: Array<{ label: string; value: number }>;
  height?: number;
  color?: string;
  secondary?: Array<{ label: string; value: number }>;
  secondaryColor?: string;
  valueFormat?: (v: number) => string;
}) {
  if (data.length === 0) {
    return <div className="flex h-40 items-center justify-center text-sm text-slate-400">No data for this range</div>;
  }
  const all = [...data, ...(secondary ?? [])];
  const max = Math.max(...all.map((d) => Math.abs(d.value)), 1);
  const min = Math.min(...all.map((d) => d.value), 0);
  const span = max - min || 1;

  const toPath = (points: Array<{ label: string; value: number }>) =>
    points
      .map((d, i) => {
        const x = all.length > 1 ? (i / (all.length - 1)) * 100 : 0;
        const y = 100 - ((d.value - min) / span) * 100;
        return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");

  return (
    <div className="relative w-full" style={{ height }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
        <path d={toPath(data)} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        {secondary && <path d={toPath(secondary)} fill="none" stroke={secondaryColor} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeDasharray="3 2" />}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-slate-400">
        <span>{data[0]?.label}</span>
        <span>{valueFormat ? valueFormat(max) : max.toLocaleString()} max</span>
        <span>{data[data.length - 1]?.label}</span>
      </div>
    </div>
  );
}

/** Pure helper: cumulative dash offsets for donut segments (no render-phase mutation). */
function computeDonutSegments(
  data: Array<{ label: string; value: number; color: string }>,
  total: number,
  circumference: number
): Array<{ d: { label: string; value: number; color: string }; dash: number; offset: number }> {
  let offset = 0;
  return data
    .filter((d) => d.value > 0)
    .map((d) => {
      const dash = (d.value / total) * circumference;
      const seg = { d, dash, offset };
      offset += dash;
      return seg;
    });
}

export function DonutChart({ data, size = 160 }: {
  data: Array<{ label: string; value: number; color: string }>;
  size?: number;
}) {
  const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
  if (total <= 0) {
    return <div className="flex h-40 items-center justify-center text-sm text-slate-400">No data for this range</div>;
  }
  const cx = 50;
  const cy = 50;
  const r = 38;
  const circumference = 2 * Math.PI * r;
  const segments = computeDonutSegments(data, total, circumference);

  return (
    <div className="flex flex-wrap items-center justify-center gap-4">
      <svg viewBox="0 0 100 100" width={size} height={size} className="shrink-0">
        {segments.map(({ d, dash, offset }, i) => (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={d.color}
            strokeWidth="14"
            strokeDasharray={`${dash} ${circumference - dash}`}
            strokeDashoffset={-offset}
            transform={`rotate(-90 ${cx} ${cy})`}
          />
        ))}
        <text x="50" y="48" textAnchor="middle" className="fill-slate-900 text-[10px] font-bold" style={{ fontSize: 11 }}>
          {total > 10000 ? `${(total / 1000).toFixed(0)}k` : total.toFixed(0)}
        </text>
        <text x="50" y="60" textAnchor="middle" className="fill-slate-400" style={{ fontSize: 6 }}>
          TOTAL
        </text>
      </svg>
      <ul className="space-y-1 text-xs">
        {data.map((d, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: d.color }} />
            <span className="text-slate-600">{d.label}</span>
            <span className="font-semibold text-slate-900">{((d.value / total) * 100).toFixed(0)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChartCard({ title, children, actions }: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
        {actions}
      </div>
      {children}
    </div>
  );
}
