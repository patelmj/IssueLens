export function PinGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="-6 -6 12 12" className={className} aria-hidden="true">
      <circle r={5.5} fill="var(--color-primary)" />
      <g transform="rotate(45)">
        <line y1={0.6} y2={3.4} stroke="#fff" strokeWidth={1.2} />
        <circle cy={-1.2} r={1.9} fill="#fff" />
      </g>
    </svg>
  );
}
