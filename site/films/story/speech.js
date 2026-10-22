export const SPEECH_STEP = .085;
export function spokenUnits(cue) {
  return cue.en.toLowerCase().match(/[a-z]+/g)
    .flatMap(word => word.length < 3 ? [...word] : [word[0], word[1], word.at(-1)]).slice(0, 10);
}
