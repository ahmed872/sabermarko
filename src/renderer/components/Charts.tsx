import { useState } from 'react';
import { money } from '../lib/format';

/** Lightweight dependency-free bar chart (RTL: most recent day on the left). */
export function BarChart({ data, height = 220, valueKey = 'value', secondKey, label = (d: any) => d.label, format = (v: number) => money(v) }: {
  data: any[]; height?: number; valueKey?: string; secondKey?: string; label?: (d: any) => string; format?: (v: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => Math.max(d[valueKey] ?? 0, secondKey ? d[secondKey] ?? 0 : 0)));
  const w = 100 / Math.max(data.length, 1);
  const h = height - 34;
  return (
    <div style={{ position: 'relative' }}>
      <svg className="chart" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ height }} role="img" aria-label="رسم بياني">
        {[0.25, 0.5, 0.75, 1].map((g) => <line key={g} x1="0" x2="100" y1={h - h * g + 4} y2={h - h * g + 4} stroke="var(--border)" strokeWidth="0.2" vectorEffect="non-scaling-stroke" />)}
        {data.map((d, i) => {
          const x = 100 - (i + 1) * w; // RTL
          const v = Math.max(0, d[valueKey] ?? 0);
          const bh = (v / max) * h;
          const v2 = secondKey ? Math.max(0, d[secondKey] ?? 0) : 0;
          const bh2 = (v2 / max) * h;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={x} y={0} width={w} height={height} fill="transparent" />
              <rect x={x + w * 0.15} y={h - bh + 4} width={secondKey ? w * 0.34 : w * 0.7} height={bh} rx="0.6" fill={hover === i ? 'var(--primary-700)' : 'var(--primary-600)'} />
              {secondKey && <rect x={x + w * 0.51} y={h - bh2 + 4} width={w * 0.34} height={bh2} rx="0.6" fill="#f59e0b" />}
            </g>
          );
        })}
      </svg>
      <div style={{ display: 'flex', flexDirection: 'row-reverse', marginTop: -26 }}>
        {data.map((d, i) => <div key={i} className="xs muted center" style={{ width: `${w}%`, overflow: 'hidden', whiteSpace: 'nowrap' }}>{label(d)}</div>)}
      </div>
      {hover !== null && data[hover] && (
        <div className="card small" style={{ position: 'absolute', top: 0, left: 8, padding: '6px 10px', pointerEvents: 'none' }}>
          <b>{label(data[hover])}</b>: {format(data[hover][valueKey] ?? 0)}{secondKey && data[hover][secondKey] !== null ? ` — الربح ${format(data[hover][secondKey] ?? 0)}` : ''}
        </div>
      )}
    </div>
  );
}

export function BarList({ rows }: { rows: { label: string; value: number; display: string; sub?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="bar-list">
      {rows.map((r, i) => (
        <div key={i} className="bar-row">
          <div className="small bold" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.label}>{r.label}</div>
          <div className="bar"><span style={{ width: `${(Math.max(r.value, 0) / max) * 100}%` }} /></div>
          <div className="small num left">{r.display}{r.sub && <div className="xs muted">{r.sub}</div>}</div>
        </div>
      ))}
    </div>
  );
}
