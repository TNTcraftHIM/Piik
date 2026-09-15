// Hint set 3 — settings: video/audio quality, degradation preference, codec, advanced door, details, more-metrics.
// Scenes follow ../Comic.tsx conventions: 320x96 canvas, 2-panel
// before→after idiom (Frame x={4} w={152} + Frame x={164} w={152}), vls-
// prefixed keyframes in an inline <style>, rmBlock for reduced motion.
import {
  FAINT,
  SKY,
  STAR_GOLD,
  Frame,
  MiniTv,
  Pawn,
  rmBlock,
} from "../Comic";
import type { HintScene, Set3Kind } from "../../../ui/visual-kinds";

// Settings explain a choice; they do not predict delivered quality.
const hintQuality: HintScene = ({ theme }) => <>
  <style>{`
.vls-quality-choice{animation:vlsQualityChoice var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-quality-size{stroke-dasharray:1;animation:vlsQualitySize var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsQualityChoice{0%,8%{transform:translateX(-43px)}30%,100%{transform:none}}
@keyframes vlsQualitySize{0%,18%{stroke-dashoffset:1}42%,100%{stroke-dashoffset:0}}
${rmBlock(["vls-quality-choice"], [[".vls-quality-choice", "transform:none"]])}
${rmBlock(["vls-quality-size"], [[".vls-quality-size", "stroke-dashoffset:0"]], false)}
`}</style>
  <Frame x={4} w={152} theme={theme} /><Frame x={164} w={152} theme={theme} result />
  {[0, 1, 2].map(index => <g key={index} transform={`translate(${index * 43} 0)`} stroke="var(--ink)" fill="none" strokeWidth={2}>
    <rect x={20} y={25} width={32} height={43} rx={5} />
    {[0, 1, ...(index ? [2] : [])].map(line => <path key={line} d={`M26 ${35 + line * 7}h20`} />)}
    {index === 2 ? <path d="M25 59h15m-4-3 4 3-4 3" /> : null}
  </g>)}
  <path className="vls-quality-choice" d="M69 75h19" stroke="var(--ink)" strokeWidth={3} strokeLinecap="round" />
  <Pawn x={190} yb={80} s={9} eyes host gaze={2} />
  <MiniTv x={220} y={25} w={70} h={43} />
  <path className="vls-quality-size" pathLength={1} d="M220 79h70m-70-4v8m70-8v8M300 25v43m-4-43h8m-8 43h8" stroke="var(--ink)" strokeWidth={2} fill="none" />
</>;

const hintAudioQuality: HintScene = ({ theme }) => <>
  <style>{`
.vls-audio-quality-wave{stroke-dasharray:1;animation:vlsAudioQualityWave var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsAudioQualityWave{0%,8%{stroke-dashoffset:1}38%,100%{stroke-dashoffset:0}}
${rmBlock(["vls-audio-quality-wave"], [[".vls-audio-quality-wave", "stroke-dashoffset:0"]], false)}
`}</style>
  <Frame x={4} w={152} theme={theme} /><Frame x={164} w={152} theme={theme} result />
  {[0, 1].map(index => <g key={index} transform={`translate(${index * 160} 0)`}>
    <Pawn x={26} yb={81} s={8} eyes host />
    <path d="M45 33h8l13-9v34l-13-9h-8Z" fill="none" stroke="var(--ink)" strokeWidth={2} strokeLinejoin="round" />
    <path d="M76 36q7 5 0 10" fill="none" stroke="var(--ink)" strokeWidth={2} strokeLinecap="round" />
    <path className={index ? "vls-audio-quality-wave" : undefined} pathLength={index ? 1 : undefined}
      d="M93 44l8-12 9 24 8-12h15" fill="none" stroke="var(--ink)" strokeWidth={2}
      strokeDasharray={index ? undefined : "3 4"} />
  </g>)}
  <text x={80} y={88} fill="var(--ink)" fontSize={11} textAnchor="middle">64 / 128 / 192</text>
  <text x={240} y={88} fill="var(--ink)" fontSize={11} textAnchor="middle">kb/s</text>
</>;

function PreferenceHint({ theme, preference }: Parameters<HintScene>[0] & {
  preference: "resolution" | "balanced" | "framerate";
}) {
  const detail = preference === "resolution";
  const motion = preference === "framerate";
  return <>
    <style>{`
.vls-pref-${preference}{transform-box:view-box;transform-origin:237px 42px;animation:vlsPref${preference} var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsPref${preference}{0%,8%{transform:rotate(${detail ? 12 : -12}deg)}24%{transform:rotate(${motion ? 3 : -3}deg)}40%,100%{transform:none}}
${rmBlock([`vls-pref-${preference}`], [[`.vls-pref-${preference}`, "transform:none"]])}
`}</style>
    <Frame x={4} w={152} theme={theme} /><Frame x={164} w={152} theme={theme} result />
    <Pawn x={25} yb={81} s={8} eyes host />
    <path d="M83 79V40m-14 39h28M49 40h68m-68 0v12m68-12v12M39 52q10 12 20 0m48 0q10 12 20 0" stroke="var(--ink)" strokeWidth={2} fill="none" />
    <rect x={41} y={26} width={17} height={14} rx={2} stroke="var(--ink)" strokeWidth={2} fill="none" />
    <path d="m44 37 5-7 6 7M105 27h15v13m-20-9h15v13m-20-9h15v13" stroke="var(--ink)" strokeWidth={1.5} fill="none" />
    <Pawn x={294} yb={81} s={8} eyes host />
    <path d="M237 79V42m-14 37h28" stroke="var(--ink)" strokeWidth={2} fill="none" />
    <g className={`vls-pref-${preference}`}><g transform={`rotate(${detail ? -12 : motion ? 12 : 0} 237 42)`} stroke="var(--ink)" strokeWidth={2} fill="none">
      <path d="M199 42h76m-76 0v14m76-14v14M189 56q10 12 20 0m56 0q10 12 20 0" />
      <rect x={190} y={27} width={18} height={15} rx={2} />
      <path d="m193 39 5-8 7 8M265 27h15v13m-20-9h15v13m-20-9h15v13" />
    </g></g>
    <path d={detail ? "M188 19h22" : motion ? "M260 19h22" : "M229 22h16m-16 6h16"}
      stroke="var(--ink)" strokeWidth={3} strokeLinecap="round" />
  </>;
}
const hintDegradePref: HintScene = props => <PreferenceHint {...props} preference="balanced" />;

const hintCodec: HintScene = ({ theme }) => <>
  <style>{`
.vls-codec-piece{animation:vlsCodecPiece var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-codec-packets{transform-box:fill-box;transform-origin:left;animation:vlsCodecPackets var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsCodecPiece{0%,8%{transform:translateX(-10px)}28%,100%{transform:none}}
@keyframes vlsCodecPackets{0%,18%{transform:scaleX(0)}42%,100%{transform:none}}
${rmBlock(["vls-codec-piece", "vls-codec-packets"], [[".vls-codec-piece,.vls-codec-packets", "transform:none"]])}
`}</style>
  <Frame x={4} w={152} theme={theme} /><Frame x={164} w={152} theme={theme} result />
  <MiniTv x={28} y={24} w={60} h={39} />
  <path d="M97 32h10a4 4 0 1 0 8 0h10v10a4 4 0 1 0 0 8v10h-28Z" fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} />
  <path className="vls-codec-piece" d="M183 33h10a4 4 0 1 0 8 0h10v10a4 4 0 1 0 0 8v10h-28Z" fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} />
  <path className="vls-codec-packets" d="M227 36h60m-60 12h60m-60 12h60" stroke="var(--ink)" strokeWidth={2} strokeDasharray="9 6" />
</>;

/** hint-advanced: closed cabinet door with a sliders glyph → door swings
 * open revealing 3 slider tracks with set knobs; the open controls are the resting pose. */
const hintAdvanced: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-adv-blink{transform-box:fill-box;transform-origin:center;animation:vlsAdvBlink var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-adv-door{transform-box:fill-box;transform-origin:left center;animation:vlsAdvDoor var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-adv-hop{transform-box:fill-box;transform-origin:50% 100%;animation:vlsAdvHop var(--comic-duration,3.2s) cubic-bezier(.3,1.5,.5,1) var(--comic-repeat,1) both}
@keyframes vlsAdvBlink{0%,52%,60%,100%{transform:scaleY(1)}56%{transform:scaleY(.12)}}
@keyframes vlsAdvDoor{0%,8%{transform:scaleX(1)}26%{transform:scaleX(.09)}33%,100%{transform:scaleX(.14)}}
@keyframes vlsAdvHop{0%,40%,62%,100%{transform:translateY(0)}46%{transform:translateY(-4.5px)}52%{transform:translateY(0)}57%{transform:translateY(-2px)}}
${rmBlock(
  ["vls-adv-blink", "vls-adv-door", "vls-adv-hop"],
  [
    [".vls-adv-blink,.vls-adv-hop", "transform:none"],
    [".vls-adv-door", "transform:scaleX(.14)"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    {/* BEFORE: closed door, sliders glyph embossed, pawn glances over */}
    <rect x={44} y={18} width={56} height={60} rx={8} fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={2.5} />
    <rect x={49} y={23} width={44} height={50} rx={5} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} />
    <path d="M56 36 H74 M56 46 H74" stroke={FAINT} strokeWidth={2} strokeLinecap="round" fill="none" />
    <circle cx={64} cy={36} r={2.5} fill="var(--ink)" />
    <circle cx={70} cy={46} r={2.5} fill="var(--ink)" />
    <circle cx={87} cy={48} r={2.5} fill="var(--ink)" />
    <Pawn x={122} yb={80} s={7.5} eyes host gaze={-2} eyeClassName="vls-adv-blink" />
    {/* AFTER: tracks + set knobs revealed as the door swings open */}
    <rect x={204} y={18} width={56} height={60} rx={8} fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={2.5} />
    <g stroke={FAINT} strokeWidth={2.5} strokeLinecap="round" fill="none">
      <path d="M215 34 H251" />
      <path d="M215 48 H251" />
      <path d="M215 62 H251" />
    </g>
    <circle cx={222} cy={34} r={4} fill="var(--ink)" stroke="var(--ink)" strokeWidth={1.5} />
    <circle cx={242} cy={48} r={4} fill={STAR_GOLD} stroke="var(--ink)" strokeWidth={1.5} />
    <circle cx={230} cy={62} r={4} fill={SKY} stroke="var(--ink)" strokeWidth={1.5} />
    <g className="vls-adv-door">
      <rect x={209} y={23} width={44} height={50} rx={5} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} />
    </g>
    <g className="vls-adv-hop">
      <Pawn x={284} yb={80} s={7.5} eyes host gaze={-2} />
    </g>
  </>
);

/** hint-details: a plain row of meter bars → magnifier pops over the bars,
 * enlarged inside the lens; the lens returns to a readable resting pose. */
const hintDetails: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-dt-lens{transform-box:fill-box;transform-origin:center;animation:vlsDtLens var(--comic-duration,3.2s) cubic-bezier(.3,1.5,.5,1) var(--comic-repeat,1) both}
.vls-dt-blink{transform-box:fill-box;transform-origin:center;animation:vlsDtBlink var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
@keyframes vlsDtLens{0%,6%{transform:scale(0);opacity:0}14%{transform:scale(1.12);opacity:1}20%,100%{transform:scale(1);opacity:1}}
@keyframes vlsDtBlink{0%,56%,64%,100%{transform:scaleY(1)}60%{transform:scaleY(.12)}}
${rmBlock(
  ["vls-dt-lens", "vls-dt-blink"],
  [
    [".vls-dt-lens", "transform:none;opacity:1"],
    [".vls-dt-blink", "transform:none"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    {/* BEFORE: plain bar row, pawn looks on */}
    <path d="M28 74 H116" stroke="var(--ink)" strokeWidth={2.5} strokeLinecap="round" fill="none" />
    <g fill="var(--ink)">
      <rect x={34} y={60} width={8} height={14} rx={2.5} />
      <rect x={50} y={50} width={8} height={24} rx={2.5} />
      <rect x={66} y={56} width={8} height={18} rx={2.5} />
      <rect x={82} y={44} width={8} height={30} rx={2.5} />
      <rect x={98} y={52} width={8} height={22} rx={2.5} />
    </g>
    <Pawn x={132} yb={80} s={7} eyes gaze={-2} />
    {/* AFTER: magnifier over the same bars, enlarged inside the lens */}
    <path d="M188 74 H276" stroke="var(--ink)" strokeWidth={2.5} strokeLinecap="round" fill="none" />
    <g fill="var(--ink)">
      <rect x={194} y={60} width={8} height={14} rx={2.5} />
      <rect x={210} y={50} width={8} height={24} rx={2.5} />
      <rect x={226} y={56} width={8} height={18} rx={2.5} />
      <rect x={242} y={44} width={8} height={30} rx={2.5} />
      <rect x={258} y={52} width={8} height={22} rx={2.5} />
    </g>
    <g className="vls-dt-lens">
      <circle cx={232} cy={52} r={21} fill="var(--paper)" stroke="var(--ink)" strokeWidth={3} />
      <path d="M247 67 L258 78" stroke="var(--ink)" strokeWidth={4} strokeLinecap="round" fill="none" />
      <g fill="var(--ink)">
        <rect x={214} y={42} width={10} height={30} rx={3} />
        <rect x={227} y={50} width={10} height={22} rx={3} />
        <rect x={240} y={40} width={10} height={32} rx={3} />
      </g>
    </g>
    <Pawn x={296} yb={80} s={7} eyes gaze={-2} eyeClassName="vls-dt-blink" />
  </>
);

/** hint-more-metrics: one meter row + chevron-down (beckons) → three rows
 * unfold with overshoot + chevron-up. The rows rest expanded. */
const hintMoreMetrics: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-mm-chev{animation:vlsMmChev var(--comic-duration,3.2s) ease-in-out var(--comic-repeat,1) both}
.vls-mm-r2{animation:vlsMmIn var(--comic-duration,3.2s) cubic-bezier(.3,1.5,.5,1) var(--comic-repeat,1) both}
.vls-mm-r3{animation:vlsMmIn var(--comic-duration,3.2s) cubic-bezier(.3,1.5,.5,1) .12s var(--comic-repeat,1) both}
@keyframes vlsMmChev{0%,30%,100%{transform:translateY(0)}15%{transform:translateY(2.5px)}}
@keyframes vlsMmIn{0%{opacity:0;transform:translateY(-7px)}8%{opacity:1;transform:translateY(1px)}14%,100%{opacity:1;transform:translateY(0)}}
${rmBlock(
  ["vls-mm-chev", "vls-mm-r2", "vls-mm-r3"],
  [
    [".vls-mm-chev", "transform:none"],
    [".vls-mm-r2,.vls-mm-r3", "opacity:1;transform:none"],
  ],
)}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    {/* BEFORE: one folded row, chevron-down bobs, pawn watches */}
    <rect x={34} y={32} width={92} height={15} rx={7.5} fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={2} />
    <g fill="var(--ink)">
      <rect x={46} y={38} width={5} height={5} rx={1.5} />
      <rect x={56} y={35} width={5} height={8} rx={1.5} />
      <rect x={66} y={37} width={5} height={6} rx={1.5} />
      <circle cx={80} cy={39.5} r={2} />
    </g>
    <path className="vls-mm-chev" d="M70 62 l10 8 l10 -8" stroke="var(--ink)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <Pawn x={140} yb={80} s={6} eyes gaze={-2} />
    {/* AFTER: three rows unfolded, chevron-up on top */}
    <path d="M230 22 l10 -7 l10 7" stroke="var(--ink)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <rect x={194} y={28} width={92} height={15} rx={7.5} fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={2} />
    <g fill="var(--ink)">
      <rect x={206} y={34} width={5} height={5} rx={1.5} />
      <rect x={216} y={31} width={5} height={8} rx={1.5} />
      <rect x={226} y={33} width={5} height={6} rx={1.5} />
      <circle cx={240} cy={35.5} r={2} />
    </g>
    <g className="vls-mm-r2">
      <rect x={194} y={46} width={92} height={15} rx={7.5} fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={2} />
      <rect x={206} y={52} width={5} height={5} rx={1.5} fill="var(--ink)" />
      <rect x={216} y={49} width={5} height={8} rx={1.5} fill="var(--ink)" />
      <rect x={226} y={51} width={5} height={6} rx={1.5} fill="var(--ink)" />
      <circle cx={240} cy={53.5} r={2} fill="var(--ink)" />
    </g>
    <g className="vls-mm-r3">
      <rect x={194} y={64} width={92} height={15} rx={7.5} fill="var(--wall-2)" stroke="var(--ink)" strokeWidth={2} />
      <rect x={206} y={70} width={5} height={5} rx={1.5} fill={STAR_GOLD} />
      <rect x={216} y={67} width={5} height={8} rx={1.5} fill={STAR_GOLD} />
      <rect x={226} y={69} width={5} height={6} rx={1.5} fill={STAR_GOLD} />
      <circle cx={240} cy={71.5} r={2} fill={STAR_GOLD} />
    </g>
    <Pawn x={300} yb={80} s={6} eyes gaze={-2} />
  </>
);

const hintDebugExport: HintScene = ({ theme }) => (
  <>
    <style>{`
.vls-export-report{animation:vlsExportReport var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
.vls-export-arrow{animation:vlsExportArrow var(--comic-duration,3.2s) ease-out var(--comic-repeat,1) both}
@keyframes vlsExportReport{0%,8%{opacity:0;transform:translateY(-8px)}30%,100%{opacity:1;transform:none}}
@keyframes vlsExportArrow{0%,26%{opacity:0}42%,100%{opacity:1}}
${rmBlock(["vls-export-report", "vls-export-arrow"], [[".vls-export-report,.vls-export-arrow", "opacity:1;transform:none"]])}
`}</style>
    <Frame x={4} w={152} theme={theme} />
    <Frame x={164} w={152} theme={theme} result />
    <path d="M32 72H128" stroke="var(--ink)" strokeWidth={2.5} strokeLinecap="round" />
    <g fill="var(--ink)">
      <rect x={40} y={54} width={12} height={18} rx={2.5} />
      <rect x={62} y={36} width={12} height={36} rx={2.5} />
      <rect x={84} y={46} width={12} height={26} rx={2.5} />
      <rect x={106} y={26} width={12} height={46} rx={2.5} />
    </g>
    <g className="vls-export-report">
      <rect x={218} y={14} width={44} height={42} rx={5} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2.5} />
      <path d="M228 45V35M240 45V25M252 45V31" stroke="var(--ink)" strokeWidth={5} strokeLinecap="round" />
    </g>
    <path className="vls-export-arrow" d="M240 61V73M234 68L240 74L246 68" fill="none"
      stroke="var(--ink)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M215 74V84H265V74" fill="none"
      stroke="var(--ink)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
  </>
);

export const SET3_SCENES: Record<Set3Kind, HintScene> = {
  "hint-quality": hintQuality,
  "hint-audio-quality": hintAudioQuality,
  "hint-degrade-pref": hintDegradePref,
  "hint-prefer-resolution": props => <PreferenceHint {...props} preference="resolution" />,
  "hint-prefer-framerate": props => <PreferenceHint {...props} preference="framerate" />,
  "hint-codec": hintCodec,
  "hint-advanced": hintAdvanced,
  "hint-details": hintDetails,
  "hint-debug-export": hintDebugExport,
  "hint-more-metrics": hintMoreMetrics,
};
