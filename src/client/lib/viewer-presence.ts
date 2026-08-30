import type {
  ParticipantPresenceEntry,
  ViewerPresenceEntry,
} from "../../shared/protocol";

interface PresenceIdentity {
  peerId: string;
  displayName: string;
}

interface PresenceLabel {
  peerIdSuffix: string;
  label: string;
}

type LabeledPresence<T extends PresenceIdentity> = T & PresenceLabel;
type HostPresenceEntry = Extract<ParticipantPresenceEntry, { role: "host" }>;

export type LabeledViewerPresence = LabeledPresence<ViewerPresenceEntry>;
export type LabeledHostPresence = LabeledPresence<HostPresenceEntry>;

export interface LabeledParticipantSnapshot {
  host: LabeledHostPresence | null;
  viewers: LabeledViewerPresence[];
}

const MIN_PEER_ID_SUFFIX_LENGTH = 6;

function comparePeerIdentity(
  left: PresenceIdentity,
  right: PresenceIdentity,
): number {
  return left.peerId < right.peerId ? -1 : left.peerId > right.peerId ? 1 : 0;
}

function labelPresence<T extends PresenceIdentity>(
  entries: readonly T[],
): LabeledPresence<T>[] {
  const nameCounts = new Map<string, number>();
  entries.forEach((entry) => {
    nameCounts.set(
      entry.displayName,
      (nameCounts.get(entry.displayName) ?? 0) + 1,
    );
  });
  const duplicateNames = new Set(
    [...nameCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([displayName]) => displayName),
  );
  const suffixLengths = entries.map((entry) =>
    Math.min(MIN_PEER_ID_SUFFIX_LENGTH, entry.peerId.length),
  );

  while (true) {
    const collisions = new Map<string, number[]>();
    entries.forEach((entry, index) => {
      if (!duplicateNames.has(entry.displayName)) {
        return;
      }
      const suffix = entry.peerId.slice(-suffixLengths[index]);
      const key = `${entry.displayName}\u0000${suffix}`;
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
        if (suffixLengths[index] < entries[index].peerId.length) {
          suffixLengths[index] += 1;
          extended = true;
        }
      }
    }
    if (!extended) {
      break;
    }
  }

  return entries.map((entry, index) => {
    const peerIdSuffix = entry.peerId.slice(-suffixLengths[index]);
    return {
      ...entry,
      peerIdSuffix,
      label: duplicateNames.has(entry.displayName)
        ? `${entry.displayName} (${peerIdSuffix})`
        : entry.displayName,
    };
  });
}

export function labelViewerPresence(
  viewers: readonly ViewerPresenceEntry[],
): LabeledViewerPresence[] {
  return labelPresence(viewers).sort(comparePeerIdentity);
}

export function labelParticipantSnapshot(
  participants: readonly ParticipantPresenceEntry[],
): LabeledParticipantSnapshot {
  const labeled = labelPresence(participants);
  return {
    host:
      labeled.find(
        (participant): participant is LabeledHostPresence =>
          participant.role === "host",
      ) ?? null,
    viewers: labeled
      .filter(
        (participant): participant is LabeledViewerPresence =>
          participant.role === "viewer",
      )
      .sort(comparePeerIdentity),
  };
}

export function labelViewerParticipants(
  participants: readonly ParticipantPresenceEntry[],
): LabeledViewerPresence[] {
  return labelParticipantSnapshot(participants).viewers;
}
