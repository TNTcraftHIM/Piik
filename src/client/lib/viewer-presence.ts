import type { ViewerPresenceEntry } from "../../shared/protocol";

export interface LabeledViewerPresence extends ViewerPresenceEntry {
  peerIdSuffix: string;
  label: string;
}

const MIN_PEER_ID_SUFFIX_LENGTH = 6;

export function labelViewerPresence(
  viewers: readonly ViewerPresenceEntry[],
): LabeledViewerPresence[] {
  const suffixLengths = viewers.map((viewer) =>
    Math.min(MIN_PEER_ID_SUFFIX_LENGTH, viewer.peerId.length),
  );

  while (true) {
    const collisions = new Map<string, number[]>();
    viewers.forEach((viewer, index) => {
      const suffix = viewer.peerId.slice(-suffixLengths[index]);
      const indexes = collisions.get(suffix) ?? [];
      indexes.push(index);
      collisions.set(suffix, indexes);
    });
    let extended = false;
    for (const indexes of collisions.values()) {
      if (indexes.length < 2) {
        continue;
      }
      for (const index of indexes) {
        if (suffixLengths[index] < viewers[index].peerId.length) {
          suffixLengths[index] += 1;
          extended = true;
        }
      }
    }
    if (!extended) {
      break;
    }
  }

  return viewers.map((viewer, index) => {
    const peerIdSuffix = viewer.peerId.slice(-suffixLengths[index]);
    return {
      ...viewer,
      peerIdSuffix,
      label: `${viewer.displayName} (${peerIdSuffix})`,
    };
  });
}
