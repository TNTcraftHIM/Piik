function containedWidth(width: number, height: number, ratio: number) {
  return Math.max(0, Math.min(width, height * ratio));
}

export interface StageTile { width: number; height: number }

/** Choose the grid with the largest total contained picture area after source controls. */
// Geometry-based selection: https://github.com/jitsi/jitsi-meet/blob/master/react/features/filmstrip/functions.web.ts
export function fittedStage(width: number, height: number, ratios: readonly number[], gap: number, footer: number,
  minimumWidth: number, minimumHeight: number) {
  const count = ratios.length;
  if (!count) return { columns: 1, tiles: [] };

  const maximum = Math.min(count, Math.max(1, Math.floor((width + gap) / (minimumWidth + gap))));
  const rowsThatFit = Math.floor((height + gap) / (minimumHeight + footer + gap));
  // When the stage must scroll, compare all layouts that use the fewest possible rows.
  const rowBudget = Math.max(rowsThatFit, Math.ceil(count / maximum));
  const minimum = Math.ceil(count / rowBudget);
  let selected: { columns: number; tiles: StageTile[] } = { columns: minimum, tiles: [] };
  let largest = 0, empty = Infinity;
  for (let columns = minimum; columns <= maximum; columns++) {
    const rows = Math.ceil(count / columns);
    const cellWidth = (width - (columns - 1) * gap) / columns;
    const pictureHeight = Math.max(minimumHeight, (height - (rows - 1) * gap) / rows - footer);
    let area = 0;
    const tiles = ratios.map(ratio => {
      const pictureWidth = containedWidth(cellWidth, pictureHeight, ratio);
      area += pictureWidth * pictureWidth / ratio;
      return {
        width: Math.max(Math.min(cellWidth, minimumWidth), pictureWidth),
        height: Math.max(minimumHeight, pictureWidth / ratio),
      };
    });
    const unused = rows * columns - count;
    if (area > largest || area === largest && unused < empty) {
      selected = { columns, tiles };
      largest = area;
      empty = unused;
    }
  }
  return selected;
}

/** Compare contained widths of the same main picture, reserving the measured controls and previews. */
export function stageFocusSidebar(width: number, height: number, ratio: number, footer: number, gap: number,
  thumbnails: readonly { width: number; height: number }[], minimumWidth: number): boolean {
  if (!thumbnails.length) return false;
  const stripWidth = Math.max(...thumbnails.map(tile => tile.width));
  // The final flexible row uses the remaining height below the last preview.
  const stackHeight = thumbnails.reduce((sum, tile) => sum + tile.height, gap * thumbnails.length);
  if (stackHeight > height || width - stripWidth - gap < minimumWidth) return false;
  const stripHeight = Math.max(...thumbnails.map(tile => tile.height));
  const below = containedWidth(width - 2, height - footer - gap - stripHeight, ratio);
  const beside = containedWidth(width - stripWidth - gap - 2, height - footer, ratio);
  return beside > below;
}
