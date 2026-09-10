/** Host role badge shared by room pawns and explanatory comics. */
export function ControllerMark({
  x,
  y,
  width = 20,
  dashed = false,
  className,
  opacity,
}: {
  x: number;
  y: number;
  width?: number;
  dashed?: boolean;
  className?: string;
  opacity?: number;
}) {
  return (
    <g
      transform={`translate(${x} ${y}) scale(${width / 22})`}
      fill="none"
      stroke="var(--pawn-2)"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      opacity={opacity}
      aria-hidden="true"
    >
      <path
        d="M5 1h10c3 0 5 5 5 9 0 3-2 3-4 1l-2-2H6l-2 2c-2 2-4 2-4-1 0-4 2-9 5-9Z"
        fill={dashed ? "none" : "var(--stage)"}
        strokeDasharray={dashed ? "3 2" : undefined}
      />
      <path d="M5 4v4M3 6h4" />
      <circle cx={14} cy={5} r={0.7} />
      <circle cx={16} cy={7} r={0.7} />
    </g>
  );
}
