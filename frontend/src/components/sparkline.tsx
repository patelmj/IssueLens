export function Sparkline({ points, stroke }: { points: number[]; stroke: string }) {
  const W = 120;
  const H = 28;
  const PAD = 2;
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points
    .map((value, idx) => {
      const x = PAD + (idx / (points.length - 1)) * (W - PAD * 2);
      const y = H - PAD - ((value - min) / span) * (H - PAD * 2);
      return `${idx === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-7 w-full" aria-hidden="true">
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.5" />
    </svg>
  );
}
