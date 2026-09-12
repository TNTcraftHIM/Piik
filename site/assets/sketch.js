// A pencil study, shared by the source thumbnail and the film. Construction
// lines stay visible; the film traces the darker contours with its own clock.
const strokes = [
  'M177 245Q160 203 195 195L414 171Q455 164 467 206L492 406Q500 445 463 451L231 477Q190 482 187 444Z',
  'M189 246Q179 214 211 211L414 187Q444 184 450 213L476 405Q480 432 453 438L231 461Q207 465 204 439Z',
  'M256 189 210 151M257 185 298 134',
  'M270 288Q282 284 285 296T278 312Q266 315 265 303T270 288',
  'M362 296Q377 271 398 291',
  'M242 475 222 506M432 455 453 486',
  'M216 221 229 441M226 447 454 426M166 523Q307 544 499 500',
].flatMap(d => d.match(/M[^M]+/g));

export function sketchMarkup(prefix) {
  return `<rect width="620" height="720" rx="5" fill="#faf7ed"/>
    <g fill="none" stroke="#bdbaac" stroke-width="1.5" opacity=".65">
      <path d="m138 197 312-36 61 341-312 31Zm33-19 63 376m193-415 62 371M123 331l390-45M304 123l59 424"/>
      <ellipse cx="336" cy="327" rx="138" ry="161" transform="rotate(-8 336 327)"/>
      <path d="M176 246q-11-48 16-55l225-27q49-3 57 42l25 201q5 51-35 49l-235 28q-46-1-49-44ZM242 184l-38-40m62 44 43-58"/>
      <ellipse cx="276" cy="300" rx="24" ry="29"/><ellipse cx="379" cy="288" rx="26" ry="28"/>
      <path d="m88 590 63-7m-45 14 119-12m273-469 38-9m-35 19 53-11"/>
    </g>
    <g fill="none" stroke="#edbc7b" stroke-width="2" opacity=".75">
      <path d="M133 471Q80 224 215 147m269 61q89 174 15 284M132 552q187 50 391-40"/>
      <path d="m121 540 11 12-16 7m384-56 23 9-16 14"/>
    </g>
    <g fill="none" stroke="#414842" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
      ${strokes.map((d,i)=>`<path id="${prefix}-stroke-${i}" d="${d}" pathLength="1" stroke-dasharray="1"/>`).join('')}
    </g>
    <g fill="none" stroke="#657066" stroke-width="1.5" opacity=".7">
      ${Array.from({length:12},(_,i)=>`<path d="m${213+i*7} ${488-i*.8} 20 15"/>`).join('')}
      ${Array.from({length:8},(_,i)=>`<path d="m${471+i*2} ${342+i*11} 12-17"/>`).join('')}
      <path d="m151 598 160-19m-144 27 66-11m169-5 119-20"/>
    </g>
    <path d="M44 54h66m-66 10h37M491 645h69m-35-8v16" stroke="#a3a699" stroke-width="2"/>
  `;
}

export function createSketch(svg, prefix) {
  const paths = strokes.map((_,i)=>svg.querySelector(`#${prefix}-stroke-${i}`));
  let distance = 0, previous = paths[0].getPointAtLength(0);
  const segments = paths.map(path => {
    const length = path.getTotalLength(), start = path.getPointAtLength(0);
    const travel = Math.hypot(start.x-previous.x,start.y-previous.y);
    const segment = { path, length, start, previous, at: distance, travel };
    distance += travel + length;
    previous = path.getPointAtLength(length);
    return segment;
  });
  return progress => {
    const p = Math.min(1,Math.max(0,progress))*distance;
    let tip = segments[0].start;
    for (const segment of segments) {
      const {path,length,start,previous,at,travel} = segment;
      const drawn = Math.min(length,Math.max(0,p-at-travel));
      path.style.strokeDashoffset = String(1-drawn/length);
      if (p < at) continue;
      // Lift and travel between disconnected strokes instead of teleporting.
      const move = travel ? Math.min(1,(p-at)/travel) : 1;
      tip = move < 1
        ? {x:previous.x+(start.x-previous.x)*move,y:previous.y+(start.y-previous.y)*move}
        : path.getPointAtLength(drawn);
    }
    return tip;
  };
}
