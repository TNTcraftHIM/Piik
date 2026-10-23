import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { HostMark } from "./HostMark";
import { bindParticipantMotion, participantMotion } from "./participant-motion";
import { useSurfaceDocument } from "../../ui/panel-window";
import { Glyph } from "../../ui/icons";

export interface PawnVoice { microphone: boolean; deafened?: boolean }

/** The accepted A silhouette, shared with the explanatory cast. */
export function PersonShape({ eyes = true, gaze = 0, eyeClassName, host }: {
  eyes?: boolean | "closed"; gaze?: number; eyeClassName?: string; host?: boolean;
}) {
  return <>
    <circle className="lr-person-head" cx="24" cy="14" r="8" stroke="none" />
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

export function PawnSvg({ color, host, identity, voice, collaboration }: {
  color: string; host?: boolean; identity?: string;
  voice?: PawnVoice;
  collaboration?: "keyboardMouse" | "gamepad";
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
      <PersonShape />
      {voice && <g className="lr-person-headset" fill="var(--paper)" stroke="var(--ink)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 15v-3a10 10 0 0 1 20 0v3" fill="none" />
        <rect x="12" y="12" width="4" height="8" rx="2" />
        <rect x="32" y="12" width="4" height="8" rx="2" />
        <g className={`lr-person-boom${voice.microphone ? "" : " is-folded"}`}>
          <path d="M34 18v2q0 3-4 3h-2" fill="none" />
          <rect x="25" y="21.5" width="4" height="3" rx="1.5" fill="var(--ink)" stroke="none" />
        </g>
        {voice.deafened && <g className="lr-person-deafened">
          <path d="m10 11 8 10" stroke="var(--paper)" strokeWidth="4.4" />
          <path d="m10 11 8 10" strokeWidth="2" />
        </g>}
      </g>}
      {host ? <HostMark x={18} y={0} width={12} /> : null}
      {collaboration && <g className="lr-person-held-device" color="var(--ink)">
        <g transform="translate(12 31)"><Glyph name={collaboration === "gamepad" ? "gamepad" : "keyboard"} size={24} /></g>
        <circle cx="13" cy="44" r="2.2" /><circle cx="35" cy="44" r="2.2" />
      </g>}
    </g></g>
  </svg>;
}
