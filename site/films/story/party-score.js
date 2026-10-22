// Coordinates are feet; the final value is the jump apex above a straight path.
// One beat score drives the game rehearsal and its sound accents.
const paths = [
  [[0,130,670],[1,220,670],[4,525,565,180],[5,610,565],[8,900,450,190],
    [10.5,1000,450],[12,750,450,80],[13.5,750,760],[16.5,930,450,360],[20.5,1430,565,200]],
  [[0,245,670],[2,300,670],[5,580,565,185],[6,640,565],[9,930,450,205],
    [10,960,450],[14,1240,565,220],[17.5,1440,565]],
];
export const PARTY = { goal: 17.5, coins: [3.5, 7.5, 13.25], impacts: [4, 5, 8, 9, 10.5, 13.5, 14, 16.5] };
export function poseAt(actor, beat) {
  const points = paths[actor], end = points.findIndex(p => p[0] > beat);
  if (end < 0) { const p = points.at(-1); return { x: p[1], y: p[2], landing: beat - p[0] }; }
  const a = points[Math.max(0, end - 1)], z = points[end];
  const p = Math.max(0, Math.min(1, (beat - a[0]) / (z[0] - a[0] || 1)));
  return { x: a[1] + (z[1] - a[1]) * p, y: a[2] + (z[2] - a[2]) * p - (z[3] || 0) * 4 * p * (1 - p),
    landing: beat - a[0] };
}
