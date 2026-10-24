import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { HostMark } from "./HostMark";
import { bindParticipantMotion, participantMotion } from "./participant-motion";
import { useSurfaceDocument } from "../../ui/panel-window";
import { Glyph } from "../../ui/icons";

export interface PawnVoice { microphone: boolean; deafened?: boolean }
export interface PawnState { voice?: PawnVoice; collaboration?: boolean; host?: boolean }

/** The accepted A silhouette, shared with the explanatory cast. */
export function PersonShape({ eyes = true, gaze = 0, eyeClassName, host }: {
  eyes?: boolean | "closed"; gaze?: number; eyeClassName?: string; host?: boolean;
}) {
  return <>
    <circle className="lr-person-head" cx="24" cy="14" r="8" stroke="none" />
    <path d="M10 47c0-13 5-20 14-20s14 7 14 20q0 3-3 3H13q-3 0-3-3Z" stroke="none" />
    {eyes ? <g className={`lr-person-eyes${eyeClassName ? ` ${eyeClassName}` : ""}`} fill="var(--person-ink, #263b43)">
      {eyes === "closed" ? <path d={`M${20.1 + gaze} 14.5q1.1-1.4 2.2 0m3.4 0q1.1-1.4 2.2 0`}
        fill="none" stroke="var(--person-ink, #263b43)" strokeWidth="2.2" strokeLinecap="round" /> : <>
        <ellipse cx={21.2 + gaze} cy="14.1" rx="1.1" ry="1.5" />
        <ellipse cx={26.8 + gaze} cy="14.1" rx="1.1" ry="1.5" />
      </>}
    </g> : null}
    {host ? <HostMark x={18} y={0} width={12} /> : null}
  </>;
}

function PawnAdornment({ voice, collaboration, host }: PawnState) {
  return <g className="lr-person-status" data-voice={voice ? "" : undefined}
    data-deafened={voice?.deafened || undefined} data-microphone={voice?.microphone || undefined}
    data-collaboration={collaboration || undefined} color="var(--person-ink, #263b43)" fill="none"
    stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
    <g className="lr-person-headset">
      <g className="lr-person-neckband">
        <path d="M15 28q0-5 9-5t9 5" strokeWidth="1.6" />
      </g>
      <g className="lr-person-headband">
        <path d={host ? "M14.8 15v-2a9.2 9.2 0 0 1 3.5-7.2m11.4 0a9.2 9.2 0 0 1 3.5 7.2v2"
          : "M14.8 15v-2a9.2 9.2 0 0 1 18.4 0v2"} strokeWidth="1.6" />
      </g>
      <path className="lr-person-earcup-left" d="M14.8 13v5" strokeWidth="3.4" />
      <path className="lr-person-earcup-right" d="M33.2 13v5" strokeWidth="3.4" />
      <g className="lr-person-mic-position">
        <path className="lr-person-mic-open lr-person-mic-head" d="M0 0v1.5q0 3-4 3h-2" strokeWidth="1.4" />
        <path className="lr-person-mic-open lr-person-mic-neck" d="M0 0v-4q0-3-4-3h-2" strokeWidth="1.4" />
        <path className="lr-person-mic-folded" d="M0 0l2-8" strokeWidth="1.4" />
        <circle className="lr-person-mic-tip" r="1.2" fill="currentColor" stroke="none" />
      </g>
    </g>
    <g className="lr-person-collaboration"><g transform="translate(16.5 32.5) rotate(-45 7.5 7.5)"><Glyph name="mouse" size={15} /></g></g>
  </g>;
}

export function PawnSvg({ color, host, identity, voice, collaboration }: PawnState & {
  color: string; identity?: string;
}) {
  const root = useRef<SVGSVGElement>(null);
  const surfaceDocument = useSurfaceDocument();
  const motion = identity ? participantMotion(identity) : null;
  useLayoutEffect(() => {
    if (identity && root.current) return bindParticipantMotion(root.current, identity);
  }, [identity, surfaceDocument]);
  return <svg ref={root} className="lr-person" viewBox="0 0 48 56" width="40" height="48"
    aria-hidden="true" data-motion={identity ? "" : undefined} style={motion ? {
      "--person-duration": `${motion.duration}ms`,
      "--person-lean": `${motion.lean}deg`,
      "--person-gaze-x": `${host ? 1.6 : motion.gaze}px`,
      "--person-gaze-y": host ? "-1.4px" : "0px",
    } as CSSProperties : undefined}>
    <g className="lr-reaction-body"><g className="lr-person-body" fill={color}>
      <PersonShape host={host} />
      <PawnAdornment host={host} voice={voice} collaboration={collaboration} />
    </g></g>
  </svg>;
}
