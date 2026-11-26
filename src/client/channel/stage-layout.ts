function containedWidth(width: number, height: number, ratio: number) {
  return Math.max(0, Math.min(width, height * ratio));
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
      const pictureWidth = containedWidth(cellWidth - (natural?.insetX ?? 0), videoHeight, ratio);
      return total + pictureWidth * pictureWidth / ratio;
    }, 0);
    const unused = rows * columns - count;
    if (area > largest || area === largest && unused < empty) {
      selected = columns; largest = area; empty = unused;
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
