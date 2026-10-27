import { PersonShape } from "../../components/living/Pawn";

/** Original illustrative content for the design boards, not received media. */
export function DesignArtwork({ kind = "game" }: { kind?: "game" | "drawing" }) {
  if (kind === "drawing") return <svg viewBox="0 0 640 360" role="img" aria-label="Illustration of a shared drawing canvas">
    <rect width="640" height="360" fill="var(--wall-2)" />
    <rect x="24" y="20" width="592" height="320" rx="10" fill="var(--paper)" />
    <path d="M24 58H616" stroke="var(--line)" />
    <g fill="var(--muted)"><circle cx="43" cy="39" r="3" /><circle cx="56" cy="39" r="3" /><circle cx="69" cy="39" r="3" /></g>
    <text x="300" y="43" textAnchor="middle" fill="var(--muted)" fontSize="13">a little place to stay.svg</text>
    <g stroke="var(--line)" strokeWidth="1"><path d="M63 83V312M32 117H605" /></g>
    <g stroke="var(--ink)" strokeWidth="4" strokeLinecap="round" fill="none">
      <path d="M182 254H477M212 254V171L321 100 430 171V254" />
      <path d="M194 177L321 93 449 177M290 254V203Q322 177 352 203V254" />
      <rect x="237" y="180" width="25" height="26" rx="3" /><rect x="381" y="180" width="25" height="26" rx="3" />
      <path d="M398 135V105H422V150" />
    </g>
    <circle cx="470" cy="107" r="22" fill="var(--couch)" />
    <path d="M147 255q-14-20 0-32q12 10 0 32m-11-9q-17-8-14-22q17 1 14 22" fill="var(--pawn-6)" />
    <g transform="translate(453 205) scale(.8)" fill="var(--pawn-5)"><PersonShape /></g>
    <g transform="translate(170 212) scale(.7)" fill="var(--pawn-2)"><PersonShape /></g>
    <g fill="var(--pawn-1)"><path d="m366 278 9-23 7 21-8-2Z" /><rect x="377" y="272" width="60" height="21" rx="5" /></g>
    <text x="407" y="287" textAnchor="middle" fill="var(--primary-ink)" fontSize="11">Mallow</text>
    <g transform="translate(43 79)" fill="var(--muted)"><rect width="7" height="13" rx="3" /><circle cy="67" r="5" /><rect x="-4" y="98" width="9" height="9" rx="2" /></g>
    <g transform="translate(268 307)">{["--pawn-1", "--pawn-5", "--pawn-6", "--couch", "--ink"].map((color, index) =>
      <circle key={color} cx={index * 25} cy="0" r="7" fill={"var(" + color + ")"} />)}</g>
  </svg>;
  return <svg viewBox="0 0 640 360" role="img" aria-label="Illustration of a two-player platform game">
    <rect width="640" height="360" fill="var(--pawn-2)" />
    <circle cx="535" cy="61" r="99" fill="var(--paper)" opacity=".13" />
    <path d="M0 231 70 166 133 199 233 111 311 172 382 119 474 216 560 154 640 216V360H0Z" fill="var(--paper)" opacity=".13" />
    <path d="M0 309 85 267 155 311 279 242 351 282 435 256 542 300 640 242V360H0Z" fill="var(--ink)" opacity=".12" />
    <g fill="var(--paper)" opacity=".65"><rect x="113" y="75" width="69" height="9" rx="5" /><rect x="139" y="61" width="44" height="16" rx="8" /><rect x="375" y="43" width="43" height="7" rx="4" /></g>
    <g stroke="var(--person-ink)" strokeWidth="2.5">
      <path d="M-8 267H163V310H-8Z" fill="var(--couch-dark)" /><path d="M-8 259H163V276H-8Z" fill="var(--couch)" />
      <rect x="212" y="230" width="112" height="22" rx="7" fill="var(--couch)" />
      <rect x="368" y="202" width="99" height="22" rx="7" fill="var(--couch)" />
      <path d="M508 166H650V279H508Z" fill="var(--couch-dark)" /><path d="M508 166H650V183H508Z" fill="var(--couch)" />
    </g>
    <g stroke="var(--person-ink)" strokeWidth="3" strokeLinecap="round"><path d="M572 165V94" /><path d="M573 96H606L596 110 606 122H573" fill="var(--pawn-5)" /></g>
    <g transform="translate(100 203) scale(1.12)" fill="var(--pawn-5)"><PersonShape /></g>
    <g transform="translate(237 172) scale(1.12)" fill="var(--pawn-6)"><PersonShape /></g>
    <path d="M150 222q28-67 89-37" fill="none" stroke="var(--paper)" strokeWidth="2" strokeDasharray="5 7" opacity=".65" />
    <g fill="var(--couch)" stroke="var(--person-ink)" strokeWidth="2">{[347, 377, 407].map((x, i) =>
      <path key={x} d={"M" + x + " " + (151 - i * 8) + "l5 8-5 8-5-8Z"} />)}</g>
    <g fill="var(--paper)" fontSize="13" fontWeight="700"><text x="26" y="34">SIDE BY SIDE</text><text x="614" y="34" textAnchor="end">02 / 06</text></g>
    <g transform="translate(270 320)" fill="var(--person-ink)"><rect width="100" height="22" rx="11" opacity=".55" /><text x="50" y="15" textAnchor="middle" fill="var(--paper)" fontSize="11">ONE MORE TRY</text></g>
  </svg>;
}
