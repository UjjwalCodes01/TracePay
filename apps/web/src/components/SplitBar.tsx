import clsx from 'clsx';

export interface SplitSegment {
  key: string;
  label: string;
  cents: number;
  /** A CSS colour, matching the segment's colour elsewhere (its citations, its legend). */
  color: string;
}

/** Where a payment went, at a glance: one bar, each share in proportion. Zero shares are left out. */
export function SplitBar({ segments, className }: { segments: SplitSegment[]; className?: string }) {
  const shown = segments.filter((s) => s.cents > 0);
  const total = shown.reduce((n, s) => n + s.cents, 0);
  if (total === 0) return null;
  return (
    <div className={clsx('flex overflow-hidden rounded-full bg-slate-100', className)} role="img" aria-label={shown.map((s) => `${s.label} ${s.cents}¢`).join(', ')}>
      {shown.map((s) => (
        <div key={s.key} style={{ width: `${(s.cents / total) * 100}%`, background: s.color }} />
      ))}
    </div>
  );
}
