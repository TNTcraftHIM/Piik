import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { HostMark } from "./HostMark";
import { bindParticipantMotion, participantMotion } from "./participant-motion";
import { useSurfaceDocument } from "../../ui/panel-window";
import { Glyph, type GlyphName } from "../../ui/icons";
import { microphoneLevelFill } from "../../room-voice/MicrophoneLevel";

export interface PawnVoice { microphone: boolean; deafened?: boolean; level?: number }
export interface PawnState { voice?: PawnVoice; collaboration?: boolean; host?: boolean; activity?: GlyphName; additionalActivity?: boolean }

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

function PawnAdornment({ voice, collaboration, activity, additionalActivity, host, avatar }: PawnState & { avatar?: boolean }) {
  const emblem = collaboration ? "mouse" : activity;
  // Keep the last worn symbol visible during its exit.
  const [lastEmblem, setLastEmblem] = useState(emblem);
  if (emblem && emblem !== lastEmblem) setLastEmblem(emblem);
  const drawn = emblem ?? lastEmblem;
  const pointer = drawn === "mouse";
  return <g className="lr-person-status" data-voice={voice ? "" : undefined}
    data-deafened={voice?.deafened || undefined} data-microphone={voice?.microphone || undefined}
    style={voice?.microphone && voice.level !== undefined ? { "--voice-level": `${microphoneLevelFill(voice.level) * 100}%` } as CSSProperties : undefined}
    data-emblem={emblem ? "" : undefined} color="var(--person-ink, #263b43)" fill="none"
    stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
    <g className="lr-person-headset">
      <g className="lr-person-neckband">
        <path d={avatar ? "M5 35a19 19 0 0 0 38 0" : "M15 28q0-5 9-5t9 5"} strokeWidth="1.6" />
      </g>
      <g className="lr-person-headband">
        <path d={avatar ? "M5 33a19 19 0 0 1 38 0"
          : host ? "M14.8 15v-2a9.2 9.2 0 0 1 3.5-7.2m11.4 0a9.2 9.2 0 0 1 3.5 7.2v2"
          : "M14.8 15v-2a9.2 9.2 0 0 1 18.4 0v2"} strokeWidth="1.6" />
      </g>
      <path className="lr-person-earcup-left" d={avatar ? "M5 28v10" : "M14.8 13v5"} strokeWidth="3.4" />
      <path className="lr-person-earcup-right" d={avatar ? "M43 28v10" : "M33.2 13v5"} strokeWidth="3.4" />
      <g className="lr-person-mic-position">
        <path className="lr-person-mic-open lr-person-mic-head" d={avatar ? "M0 0a19 19 0 0 1-8 10.5" : "M0 0v1.5q0 3-4 3h-2"} strokeWidth="1.4" />
        <path className="lr-person-mic-open lr-person-mic-neck" d="M0 0v-4q0-3-4-3h-2" strokeWidth="1.4" />
        <path className="lr-person-mic-folded" d="M0 0l2-8" strokeWidth="1.4" />
        <circle className="lr-person-mic-tip" r="1.2" fill="currentColor" stroke="none" />
      </g>
    </g>
    <g className="lr-person-emblem" color={avatar ? "var(--ink)" : undefined}>
      {avatar && <circle cx="10" cy="48" r="7" fill="var(--paper)" stroke="none" />}
      <g transform={avatar ? `translate(4.5 42.5)${pointer ? " rotate(-45 5.5 5.5)" : ""}`
        : pointer ? `translate(${additionalActivity ? 13.5 : 16.5} 32.5) rotate(-45 7.5 7.5)` : `translate(${additionalActivity ? 14 : 17} 33)`}>
        {drawn && <Glyph name={drawn} size={avatar ? 11 : pointer ? 15 : 14} />}
      </g>
      {additionalActivity && <g transform={avatar ? "translate(14 43)" : "translate(27 35)"}>
        {avatar && <circle cx="5" cy="5" r="4.5" fill="var(--paper)" stroke="none" />}
        <Glyph name="plus" size={10} />
      </g>}
    </g>
  </g>;
}

export function PawnSvg({ color, host, identity, voice, collaboration, activity, additionalActivity, avatar, centered }: PawnState & {
  color: string; identity?: string; avatar?: string; centered?: boolean;
}) {
  const avatarClip = useId();
  const [failedAvatar, setFailedAvatar] = useState<string>();
  const picture = avatar === failedAvatar ? undefined : avatar;
  const root = useRef<SVGSVGElement>(null);
  const surfaceDocument = useSurfaceDocument();
  const motion = identity ? participantMotion(identity) : null;
  useLayoutEffect(() => {
    if (identity && root.current) return bindParticipantMotion(root.current, identity);
  }, [identity, surfaceDocument]);
  // The standing figure and the round picture share a footline, with different centres.
  const frameTop = centered && picture ? 5 : 0;
  return <svg ref={root} className="lr-person" viewBox={`0 ${frameTop} 48 56`} width="40" height="48"
    aria-hidden="true" data-avatar={picture ? "" : undefined} data-motion={identity ? "" : undefined} style={motion ? {
      "--person-duration": `${motion.duration}ms`,
      "--person-lean": `${motion.lean}deg`,
      "--person-gaze-x": `${host ? 1.6 : motion.gaze}px`,
      "--person-gaze-y": host ? "-1.4px" : "0px",
    } as CSSProperties : undefined}>
    <g className="lr-reaction-body"><g className="lr-person-body" fill={color}>
      {picture ? <>
        <defs><clipPath id={avatarClip}><circle cx="24" cy="33" r="17" /></clipPath></defs>
        <circle cx="24" cy="33" r="17" />
        <image key={picture} className="lr-person-head lr-person-avatar" href={picture} x="7" y="16" width="34" height="34"
          preserveAspectRatio="xMidYMid slice" clipPath={`url(#${avatarClip})`} onError={() => setFailedAvatar(picture)} />
        {host && <HostMark x={18} y={frameTop} width={12} />}
      </> : <PersonShape host={host} />}
      <PawnAdornment host={host} voice={voice} collaboration={collaboration} activity={activity} additionalActivity={additionalActivity} avatar={!!picture} />
    </g></g>
  </svg>;
}
