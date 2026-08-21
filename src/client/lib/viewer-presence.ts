import type {
  ParticipantPresenceEntry,
  ViewerPresenceEntry,
} from "../../shared/protocol";

export interface LabeledViewerPresence extends ViewerPresenceEntry {
  peerIdSuffix: string;
  label: string;
}

const MIN_PEER_ID_SUFFIX_LENGTH = 6;

export function labelViewerPresence(
  viewers: readonly ViewerPresenceEntry[],
): LabeledViewerPresence[] {
  const nameCounts = new Map<string, number>();
  viewers.forEach((viewer) => {
    nameCounts.set(
      viewer.displayName,
      (nameCounts.get(viewer.displayName) ?? 0) + 1,
    );
  });
  const duplicateNames = new Set(
    [...nameCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([displayName]) => displayName),
  );
  const suffixLengths = viewers.map((viewer) =>
    Math.min(MIN_PEER_ID_SUFFIX_LENGTH, viewer.peerId.length),
  );

  while (true) {
    const collisions = new Map<string, number[]>();
    viewers.forEach((viewer, index) => {
      if (!duplicateNames.has(viewer.displayName)) {
        return;
      }
      const suffix = viewer.peerId.slice(-suffixLengths[index]);
      const key = `${viewer.displayName}\u0000${suffix}`;
      const indexes = collisions.get(key) ?? [];
      indexes.push(index);
      collisions.set(key, indexes);
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
      label: duplicateNames.has(viewer.displayName)
        ? `${viewer.displayName} (${peerIdSuffix})`
        : viewer.displayName,
    };
  });
}

export function labelViewerParticipants(
  participants: readonly ParticipantPresenceEntry[],
): LabeledViewerPresence[] {
  return labelViewerPresence(
    participants.filter(
      (participant): participant is ViewerPresenceEntry =>
        participant.role === "viewer",
    ),
  );
}
