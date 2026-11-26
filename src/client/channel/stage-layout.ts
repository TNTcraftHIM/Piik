export interface StageTile { width: number; height: number }
export interface StageLayout { columns: number; rows: number; tiles: StageTile[] }

/** Size each picture at its own aspect inside equal cells, with the column count that draws the most picture.
 * A tile is the picture plus its information bar; nothing inside a tile is letterbox. An unbounded height
 * (Infinity) stacks pictures at full width. A column narrower than minWidth is not considered, so the
 * information bar keeps one line. Ties keep fewer empty cells, then fewer columns. */
export function stageLayout(aspects: readonly number[], width: number, height: number, gap: number, barHeight: number, minWidth = 0): StageLayout {
  const count = aspects.length;
  let best: StageLayout = { columns: 1, rows: count, tiles: aspects.map(() => ({ width: 0, height: 0 })) };
  let largest = -1, empty = Infinity;
  for (let columns = 1; columns <= Math.max(1, count); columns++) {
    const rows = Math.ceil(count / columns);
    const cellWidth = (width - (columns - 1) * gap) / columns;
    const pictureHeight = (height - (rows - 1) * gap) / rows - barHeight;
    if (cellWidth <= 0 || pictureHeight <= 0 || columns > 1 && cellWidth < minWidth) continue;
    const tiles = aspects.map(aspect => {
      const pictureWidth = Math.min(cellWidth, pictureHeight * aspect);
      return { width: pictureWidth, height: pictureWidth / aspect };
    });
    const area = tiles.reduce((total, tile) => total + tile.width * tile.height, 0);
    const unused = rows * columns - count;
    if (area > largest + 0.5 || Math.abs(area - largest) <= 0.5 && unused < empty) {
      best = { columns, rows, tiles }; largest = area; empty = unused;
    }
  }
  return best;
}

/** Choose the grid with the largest total contained picture area after source controls. */
// Geometry-based selection: https://github.com/jitsi/jitsi-meet/blob/master/react/features/filmstrip/functions.web.ts
export function stageColumns(width: number, height: number, ratios: readonly number[], gap: number, footer: number, minimumWidth: number,
  natural?: { ratio: number; insetX: number; insetY: number; minHeight: number }): number {
  const count = ratios.length;
  let selected = 1, largest = 0, empty = Infinity;
  const maximum = Math.min(count, Math.max(1, Math.floor((width + gap) / (Math.min(width, minimumWidth) + gap))));
  if (natural) selected = maximum;
  for (let columns = 1; columns <= maximum; columns++) {
    const rows = Math.ceil(count / columns);
    const cellWidth = (width - (columns - 1) * gap) / columns - 2;
    const videoHeight = natural
      ? Math.max(natural.minHeight, natural.ratio ? (cellWidth - natural.insetX) / natural.ratio : 0)
      : (height - (rows - 1) * gap) / rows - footer;
    // Intrinsic rows cannot shrink to the bounded height assumed by a media grid.
    if (natural && rows * (videoHeight + natural.insetY + footer) + (rows - 1) * gap > height) continue;
    const area = ratios.reduce((total, ratio) => {
      const pictureWidth = Math.max(0, Math.min(cellWidth - (natural?.insetX ?? 0), videoHeight * ratio));
      return total + pictureWidth * pictureWidth / ratio;
    }, 0);
    const unused = rows * columns - count;
    if (area > largest || area === largest && unused < empty) {
      selected = columns; largest = area; empty = unused;
    }
  }
  return selected;
}
