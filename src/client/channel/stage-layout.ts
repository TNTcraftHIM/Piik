/** Choose the grid with the largest total contained picture area after source controls. */
// Geometry-based selection: https://github.com/jitsi/jitsi-meet/blob/master/react/features/filmstrip/functions.web.ts
export function stageColumns(width: number, height: number, ratios: readonly number[], gap: number, footer: number, minimumWidth: number): number {
  const count = ratios.length;
  let selected = 1, largest = 0, empty = Infinity;
  const maximum = Math.min(count, Math.max(1, Math.floor((width + gap) / (Math.min(width, minimumWidth) + gap))));
  for (let columns = 1; columns <= maximum; columns++) {
    const rows = Math.ceil(count / columns);
    const cellWidth = (width - (columns - 1) * gap) / columns - 2;
    const videoHeight = (height - (rows - 1) * gap) / rows - footer;
    const area = ratios.reduce((total, ratio) => {
      const pictureWidth = Math.max(0, Math.min(cellWidth, videoHeight * ratio));
      return total + pictureWidth * pictureWidth / ratio;
    }, 0);
    const unused = rows * columns - count;
    if (area > largest || area === largest && unused < empty) {
      selected = columns; largest = area; empty = unused;
    }
  }
  return selected;
}
