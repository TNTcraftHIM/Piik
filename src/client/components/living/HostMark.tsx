/** The gold Host crown, shared by room pawns and explanatory comics. */

export function HostMark({
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
      transform={`translate(${x} ${y}) scale(${width / 12})`}
      fill="none"
      stroke={dashed ? "var(--ink)" : "#705025"}
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      opacity={opacity}
      strokeDasharray={dashed ? "1.2 1" : undefined}
      aria-hidden="true"
    >
      <path d="m1.2 6.3-1.2-3.7q-.2-.7.5-.4L3 3.6l2.4-2.5q.6-.7 1.2 0L9 3.6l2.5-1.4q.7-.3.5.4l-1.2 3.7q-.2.9-1.2.9H2.4q-1 0-1.2-.9Z"
        fill={dashed ? "none" : "#f7d861"} />
      {!dashed ? <path d="M2.1 6.5h7.8" stroke="#b58a2f" strokeWidth={1} /> : null}
    </g>
  );
}
