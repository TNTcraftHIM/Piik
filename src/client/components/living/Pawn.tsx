import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { HostMark } from "./HostMark";
import { bindParticipantMotion, participantMotion } from "./participant-motion";

/** The accepted A silhouette, shared with the explanatory cast. */
export function PersonShape({ eyes = true, gaze = 0, eyeClassName, host }: {
  eyes?: boolean | "closed"; gaze?: number; eyeClassName?: string; host?: boolean;
}) {
  return <>
    <circle cx="24" cy="14" r="8" stroke="none" />
    <path d="M10 47c0-13 5-20 14-20s14 7 14 20q0 3-3 3H13q-3 0-3-3Z" stroke="none" />
    {eyes ? <g className={`lr-person-eyes${eyeClassName ? ` ${eyeClassName}` : ""}`} fill="#263b43">
      {eyes === "closed" ? <path d={`M${20.1 + gaze} 14.5q1.1-1.4 2.2 0m3.4 0q1.1-1.4 2.2 0`}
        fill="none" stroke="#263b43" strokeWidth="2.2" strokeLinecap="round" /> : <>
        <ellipse cx={21.2 + gaze} cy="14.1" rx="1.1" ry="1.5" />
        <ellipse cx={26.8 + gaze} cy="14.1" rx="1.1" ry="1.5" />
      </>}
    </g> : null}
    {host ? <HostMark x={18} y={0} width={12} /> : null}
  </>;
}

export function PawnSvg({ color, host, identity }: {
  color: string; host?: boolean; identity?: string;
}) {
  const root = useRef<SVGSVGElement>(null);
  const motion = identity ? participantMotion(identity) : null;
  useLayoutEffect(() => {
    if (identity && root.current) return bindParticipantMotion(root.current, identity);
  }, [identity]);
  return <svg ref={root} className="lr-person" viewBox="0 0 48 56" width="40" height="48"
    aria-hidden="true" data-motion={identity ? "" : undefined} style={motion ? {
      "--person-duration": `${motion.duration}ms`,
      "--person-lean": `${motion.lean}deg`,
      "--person-gaze-x": `${host ? 1.6 : motion.gaze}px`,
      "--person-gaze-y": host ? "-1.4px" : "0px",
    } as CSSProperties : undefined}>
    <g className="lr-person-body" fill={color}><PersonShape host={host} /></g>
  </svg>;
}
