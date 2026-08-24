import type {
  ClientMessage,
  CodecPreparationBinding,
  CodecProofBinding,
  CodecTransitionGeneration,
  ResumeAttempt,
  ServerMessage,
  VideoCodecPreference,
} from "../shared/protocol.js";
import type {
  CodecRouteSnapshot,
  CodecRouteTarget,
} from "./hybrid-media-router.js";

const DEFAULT_CODEC_TRANSITION_TIMEOUT_MS = 20_000;

type PreparedMessage = Extract<
  ClientMessage,
  { type: "video-codec-prepared" }
>;
type ProofMessage = Extract<ClientMessage, { type: "video-codec-proof" }>;
type ResultMessage = Extract<ServerMessage, { type: "video-codec-result" }>;
type TransitionFailure = NonNullable<ResultMessage["failure"]>;
type FrozenTarget = CodecRouteTarget;

interface Preparation {
  ownerSessionId: string;
  binding: CodecPreparationBinding;
}

interface Transaction {
  hostSessionId: string;
  shareGeneration: string;
  generation: CodecTransitionGeneration;
  requested: VideoCodecPreference;
  previous: VideoCodecPreference;
  rollback: boolean;
  requiresSfuReplacement: boolean;
  sfuOperationPending: boolean;
  phase:
    | "initializing"
    | "preparing"
    | "prepared"
    | "awaiting-source"
    | "proving"
    | "rollback-prepared"
    | "failed";
  failure: TransitionFailure | null;
  targets: Map<string, FrozenTarget>;
  pendingPreparations: Map<string, Preparation>;
  pendingProofs: Set<string>;
  proofRevision: number | null;
  timer?: NodeJS.Timeout;
}

interface PendingResume {
  hostSessionId: string;
  shareGeneration: string;
  codecGeneration: CodecTransitionGeneration | null;
  resumeAttempt: ResumeAttempt;
  deadlineAtMs: number;
  timer: NodeJS.Timeout;
}

export interface CodecTransitionCoordinatorOptions {
  snapshot: (roomId: string) => CodecRouteSnapshot | null;
  sendToSession: (sessionId: string, message: ServerMessage) => void;
  commitCodec: (roomId: string, videoCodec: VideoCodecPreference) => void;
  authorizeResume: (
    roomId: string,
    hostSessionId: string,
    shareGeneration: string,
    codecGeneration: CodecTransitionGeneration | null,
    resumeAttempt: ResumeAttempt,
  ) => void;
  confirmSourceEnabled: (
    roomId: string,
    hostSessionId: string,
    shareGeneration: string,
    codecGeneration: CodecTransitionGeneration | null,
    resumeAttempt: ResumeAttempt,
  ) => boolean;
  restoreAuthoritativePause: (
    roomId: string,
    hostSessionId: string,
    shareGeneration: string,
    codecGeneration: CodecTransitionGeneration | null,
    resumeAttempt: ResumeAttempt | null,
  ) => void;
  returnTargetsToRouteWait: (
    roomId: string,
    viewerPeerIds: readonly string[],
  ) => void;
  beginSfuReplacement: (input: {
    roomId: string;
    hostSessionId: string;
    generation: CodecTransitionGeneration;
    videoCodec: VideoCodecPreference;
    timeoutMs: number;
  }) => Promise<CodecRouteSnapshot | null>;
  parkSfuReplacement: (
    roomId: string,
    generation: CodecTransitionGeneration,
  ) => boolean;
  beginSfuProof: (
    roomId: string,
    generation: CodecTransitionGeneration,
    timeoutMs: number,
  ) => boolean;
  abortSfuReplacement: (
    roomId: string,
    generation: CodecTransitionGeneration,
  ) => void;
  releaseRoutePause: (roomId: string) => void;
  timeoutMs?: number;
  createGeneration?: () => CodecTransitionGeneration;
  createResumeAttempt?: () => ResumeAttempt;
  now?: () => number;
}

export class CodecTransitionCoordinator {
  private readonly rooms = new Map<string, Transaction>();
  private readonly timeoutMs: number;
  private readonly createGeneration: () => CodecTransitionGeneration;
  private readonly createResumeAttempt: () => ResumeAttempt;
  private readonly now: () => number;
  private latestGeneration = 0;
  private latestResumeAttempt = 0;
  private readonly pendingResumes = new Map<string, PendingResume>();
  private readonly revalidatingRoomIds = new Set<string>();
  private readonly deferredRevalidationRoomIds = new Set<string>();

  constructor(private readonly options: CodecTransitionCoordinatorOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CODEC_TRANSITION_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Codec transition timeout must be a positive integer");
    }
    this.createGeneration =
      options.createGeneration ?? (() => this.latestGeneration + 1);
    this.createResumeAttempt =
      options.createResumeAttempt ?? (() => this.latestResumeAttempt + 1);
    this.now = options.now ?? Date.now;
  }

  start(input: {
    roomId: string;
    hostSessionId: string;
    shareGeneration: string;
    requested: VideoCodecPreference;
    previous: VideoCodecPreference;
  }): "started" | "committed" | "busy" | "unavailable" {
    if (this.rooms.has(input.roomId)) {
      return "busy";
    }
    const snapshot = this.options.snapshot(input.roomId);
    if (!snapshot) {
      return "unavailable";
    }
    if (snapshot.targets.length === 0) {
      this.options.commitCodec(input.roomId, input.requested);
      this.sendResult(input.hostSessionId, {
        generation: this.allocateGeneration(),
        videoCodec: input.requested,
        status: "committed",
        failure: null,
      });
      return "committed";
    }
    const transaction: Transaction = {
      hostSessionId: input.hostSessionId,
      shareGeneration: input.shareGeneration,
      generation: this.allocateGeneration(),
      requested: input.requested,
      previous: input.previous,
      rollback: false,
      requiresSfuReplacement: snapshot.targets.some(isSfuTarget),
      sfuOperationPending: false,
      phase: "initializing",
      failure: null,
      targets: new Map(),
      pendingPreparations: new Map(),
      pendingProofs: new Set(),
      proofRevision: null,
    };
    this.rooms.set(input.roomId, transaction);
    this.beginTransactionPreparation(input.roomId, transaction, snapshot);
    return "started";
  }

  prepared(
    roomId: string,
    senderSessionId: string,
    message: PreparedMessage,
  ): void {
    let transaction = this.rooms.get(roomId);
    if (!this.messageOwns(transaction, message)) {
      return;
    }
    this.revalidate(roomId, transaction);
    transaction = this.rooms.get(roomId);
    if (!this.messageOwns(transaction, message)) {
      return;
    }
    const key = preparationKey(message.binding);
    const expected = transaction.pendingPreparations.get(key);
    if (
      transaction.phase !== "preparing" ||
      !expected ||
      expected.ownerSessionId !== senderSessionId ||
      !samePreparationBinding(expected.binding, message.binding)
    ) {
      return;
    }
    if (!message.accepted) {
      this.preparationFailed(roomId, transaction);
      return;
    }
    transaction.pendingPreparations.delete(key);
    if (transaction.pendingPreparations.size === 0) {
      this.finishPreparation(roomId, transaction);
    }
  }

  requestResume(input: {
    roomId: string;
    hostSessionId: string;
    shareGeneration: string;
  }): "normal" | "started-proof" | "busy" {
    if (this.pendingResumes.has(input.roomId)) {
      return "busy";
    }
    let transaction = this.rooms.get(input.roomId);
    if (!transaction) {
      this.beginResumeAttempt(input, null);
      return "normal";
    }
    if (
      transaction.hostSessionId !== input.hostSessionId ||
      transaction.shareGeneration !== input.shareGeneration ||
      (transaction.phase !== "prepared" &&
        transaction.phase !== "rollback-prepared")
    ) {
      return "busy";
    }
    this.revalidate(input.roomId, transaction);
    transaction = this.rooms.get(input.roomId);
    if (
      !transaction ||
      transaction.hostSessionId !== input.hostSessionId ||
      transaction.shareGeneration !== input.shareGeneration ||
      (transaction.phase !== "prepared" &&
        transaction.phase !== "rollback-prepared")
    ) {
      return "busy";
    }
    if (transaction.targets.size === 0) {
      this.finishProof(input.roomId, transaction, false);
      this.beginResumeAttempt(input, null);
      return "started-proof";
    }
    transaction.phase = "awaiting-source";
    transaction.proofRevision = null;
    transaction.pendingProofs = new Set(transaction.targets.keys());
    this.beginResumeAttempt(input, transaction.generation);
    return "started-proof";
  }

  sourceEnabled(input: {
    roomId: string;
    hostSessionId: string;
    shareGeneration: string;
    codecGeneration: CodecTransitionGeneration | null;
    resumeAttempt: ResumeAttempt;
  }): boolean {
    const pending = this.pendingResumes.get(input.roomId);
    if (!sameResumeAttempt(pending, input)) {
      return false;
    }
    if (pending.deadlineAtMs <= this.now()) {
      this.resumeAttemptExpired(input.roomId, pending);
      return false;
    }

    if (input.codecGeneration === null) {
      if (
        !this.options.confirmSourceEnabled(
          input.roomId,
          input.hostSessionId,
          input.shareGeneration,
          null,
          input.resumeAttempt,
        )
      ) {
        return false;
      }
      this.clearPendingResume(input.roomId, pending);
      this.options.releaseRoutePause(input.roomId);
      return true;
    }

    let transaction = this.rooms.get(input.roomId);
    if (
      !transaction ||
      transaction.phase !== "awaiting-source" ||
      transaction.generation !== input.codecGeneration
    ) {
      return false;
    }
    this.revalidate(input.roomId, transaction);
    transaction = this.rooms.get(input.roomId);
    const currentPending = this.pendingResumes.get(input.roomId);
    if (
      !transaction ||
      transaction.phase !== "awaiting-source" ||
      transaction.generation !== input.codecGeneration ||
      !sameResumeAttempt(currentPending, input)
    ) {
      return false;
    }
    const remainingMs = currentPending.deadlineAtMs - this.now();
    if (remainingMs <= 0) {
      this.resumeAttemptExpired(input.roomId, currentPending);
      return false;
    }
    if (
      !this.options.confirmSourceEnabled(
        input.roomId,
        input.hostSessionId,
        input.shareGeneration,
        input.codecGeneration,
        input.resumeAttempt,
      )
    ) {
      return false;
    }
    if (transaction.targets.size === 0) {
      this.finishProof(input.roomId, transaction);
      return true;
    }
    if (
      transaction.sfuOperationPending &&
      !this.options.beginSfuProof(
        input.roomId,
        transaction.generation,
        Math.max(1, Math.ceil(remainingMs)),
      )
    ) {
      this.proofFailed(input.roomId, transaction);
      return false;
    }
    transaction.phase = "proving";
    transaction.proofRevision = null;
    transaction.pendingProofs = new Set(transaction.targets.keys());
    this.revalidate(input.roomId, transaction);
    const proving = this.rooms.get(input.roomId);
    if (proving === transaction && proving.phase === "proving") {
      if (proving.targets.size === 0) {
        this.finishProof(input.roomId, proving);
      } else {
        this.issueProofBatch(input.roomId, proving);
      }
    }
    return true;
  }

  pause(input: {
    roomId: string;
    hostSessionId: string;
    shareGeneration: string;
  }): void {
    const pending = this.pendingResumes.get(input.roomId);
    if (
      pending &&
      (pending.hostSessionId !== input.hostSessionId ||
        pending.shareGeneration !== input.shareGeneration)
    ) {
      return;
    }
    if (pending) {
      this.clearPendingResume(input.roomId, pending);
    }
    const transaction = this.rooms.get(input.roomId);
    if (
      !transaction ||
      transaction.hostSessionId !== input.hostSessionId ||
      transaction.shareGeneration !== input.shareGeneration ||
      (transaction.phase !== "awaiting-source" &&
        transaction.phase !== "proving")
    ) {
      return;
    }
    transaction.pendingProofs.clear();
    transaction.proofRevision = null;
    if (transaction.sfuOperationPending) {
      this.options.parkSfuReplacement(input.roomId, transaction.generation);
    }
    transaction.phase = transaction.rollback
      ? "rollback-prepared"
      : "prepared";
  }

  proof(roomId: string, senderSessionId: string, message: ProofMessage): void {
    let transaction = this.rooms.get(roomId);
    let pendingResume = this.pendingResumes.get(roomId);
    if (
      !this.messageOwns(transaction, message) ||
      !pendingResume ||
      pendingResume.codecGeneration !== message.generation ||
      pendingResume.resumeAttempt !== message.resumeAttempt ||
      transaction.phase !== "proving"
    ) {
      return;
    }
    this.revalidate(roomId, transaction);
    transaction = this.rooms.get(roomId);
    pendingResume = this.pendingResumes.get(roomId);
    if (
      !this.messageOwns(transaction, message) ||
      !pendingResume ||
      pendingResume.codecGeneration !== message.generation ||
      pendingResume.resumeAttempt !== message.resumeAttempt ||
      transaction.phase !== "proving" ||
      transaction.proofRevision !== message.routeRevision
    ) {
      return;
    }
    const target = [...transaction.targets.values()].find(
      (candidate) => candidate.viewerSessionId === senderSessionId,
    );
    if (
      !target ||
      !transaction.pendingProofs.has(target.viewerPeerId) ||
      !target.proofReady ||
      target.routeRevision !== message.routeRevision ||
      !sameProofBinding(target.proofBinding, message.binding)
    ) {
      return;
    }
    const expected = expectedActualCodec(transaction);
    if (expected && message.evidence.actualCodec !== expected) {
      this.proofFailed(roomId, transaction);
      return;
    }
    transaction.pendingProofs.delete(target.viewerPeerId);
    if (transaction.pendingProofs.size === 0) {
      this.finishProof(roomId, transaction);
    }
  }

  participantChanged(roomId: string): void {
    if (this.revalidatingRoomIds.has(roomId)) {
      this.deferredRevalidationRoomIds.add(roomId);
      return;
    }
    const transaction = this.rooms.get(roomId);
    if (!transaction || transaction.phase === "failed") {
      return;
    }
    this.revalidate(roomId, transaction);
    const current = this.rooms.get(roomId);
    if (current !== transaction) {
      return;
    }
    if (
      transaction.targets.size === 0 &&
      transaction.phase !== "initializing" &&
      transaction.phase !== "awaiting-source"
    ) {
      this.finishProof(
        roomId,
        transaction,
        transaction.phase === "proving",
      );
      return;
    }
    if (
      transaction.phase === "preparing" &&
      transaction.pendingPreparations.size === 0
    ) {
      this.finishPreparation(roomId, transaction);
    } else if (transaction.phase === "proving") {
      this.issueProofBatch(roomId, transaction);
      if (transaction.pendingProofs.size === 0) {
        this.finishProof(roomId, transaction);
      }
    }
  }

  clearRoom(roomId: string): void {
    this.deferredRevalidationRoomIds.delete(roomId);
    this.clearPendingResume(roomId);
    const transaction = this.rooms.get(roomId);
    if (!transaction) {
      return;
    }
    this.clearDeadline(transaction);
    this.abortPendingSfuOperation(roomId, transaction);
    this.rooms.delete(roomId);
  }

  blocksResume(roomId: string): boolean {
    return this.rooms.has(roomId) || this.pendingResumes.has(roomId);
  }

  invalidateHostSession(roomId: string, nextHostSessionId?: string): void {
    const pendingResume = this.pendingResumes.get(roomId);
    this.clearPendingResume(roomId, pendingResume);
    const transaction = this.rooms.get(roomId);
    if (!transaction) {
      if (pendingResume && nextHostSessionId) {
        this.options.restoreAuthoritativePause(
          roomId,
          nextHostSessionId,
          pendingResume.shareGeneration,
          null,
          null,
        );
      }
      return;
    }
    this.clearDeadline(transaction);
    this.abortPendingSfuOperation(roomId, transaction);
    transaction.pendingPreparations.clear();
    transaction.pendingProofs.clear();
    transaction.proofRevision = null;
    transaction.phase = "failed";
    transaction.failure = "stale-binding";
    if (nextHostSessionId) {
      transaction.hostSessionId = nextHostSessionId;
    }
    this.options.restoreAuthoritativePause(
      roomId,
      transaction.hostSessionId,
      transaction.shareGeneration,
      transaction.generation,
      null,
    );
    this.sendResult(transaction.hostSessionId, {
      generation: transaction.generation,
      videoCodec: transaction.previous,
      status: "failed",
      failure: "stale-binding",
    });
  }

  close(): void {
    for (const [roomId, transaction] of this.rooms) {
      this.clearDeadline(transaction);
      this.abortPendingSfuOperation(roomId, transaction);
    }
    for (const pending of this.pendingResumes.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingResumes.clear();
    this.rooms.clear();
    this.revalidatingRoomIds.clear();
    this.deferredRevalidationRoomIds.clear();
  }

  private beginTransactionPreparation(
    roomId: string,
    transaction: Transaction,
    snapshot: CodecRouteSnapshot,
  ): void {
    transaction.requiresSfuReplacement = snapshot.targets.some(isSfuTarget);
    transaction.sfuOperationPending = false;
    transaction.phase = transaction.requiresSfuReplacement
      ? "initializing"
      : "preparing";
    transaction.pendingPreparations.clear();
    transaction.pendingProofs.clear();
    transaction.proofRevision = null;
    this.armDeadline(roomId, transaction, () =>
      this.preparationFailed(roomId, transaction),
    );
    if (!transaction.requiresSfuReplacement) {
      transaction.targets = freezeTargets(snapshot);
      this.sendPreparationRequests(roomId, transaction);
      return;
    }
    const generation = transaction.generation;
    transaction.sfuOperationPending = true;
    const videoCodec = transaction.rollback
      ? transaction.previous
      : transaction.requested;
    void this.options
      .beginSfuReplacement({
        roomId,
        hostSessionId: transaction.hostSessionId,
        generation,
        videoCodec,
        timeoutMs: this.timeoutMs,
      })
      .then((preparedSnapshot) => {
        const current = this.rooms.get(roomId);
        if (
          current !== transaction ||
          transaction.generation !== generation ||
          transaction.phase !== "initializing"
        ) {
          this.options.abortSfuReplacement(roomId, generation);
          return;
        }
        if (!preparedSnapshot || !preparedSnapshot.targets.some(isSfuTarget)) {
          this.abortPendingSfuOperation(roomId, transaction);
          const currentSnapshot = this.options.snapshot(roomId);
          if (
            !currentSnapshot ||
            currentSnapshot.targets.some(isSfuTarget)
          ) {
            this.preparationFailed(roomId, transaction);
            return;
          }
          transaction.requiresSfuReplacement = false;
          transaction.targets = freezeTargets(currentSnapshot);
          transaction.phase = "preparing";
          this.sendPreparationRequests(roomId, transaction);
          return;
        }
        transaction.targets = freezeTargets(preparedSnapshot);
        transaction.phase = "preparing";
        this.sendPreparationRequests(roomId, transaction);
      })
      .catch(() => {
        const current = this.rooms.get(roomId);
        if (
          current === transaction &&
          transaction.generation === generation &&
          transaction.phase === "initializing"
        ) {
          this.preparationFailed(roomId, transaction);
        } else {
          this.options.abortSfuReplacement(roomId, generation);
        }
      });
  }

  private sendPreparationRequests(
    roomId: string,
    transaction: Transaction,
  ): void {
    transaction.pendingPreparations = preparationsFor(transaction.targets);
    if (transaction.pendingPreparations.size === 0) {
      if (transaction.targets.size === 0) {
        this.finishProof(roomId, transaction, false);
      } else {
        this.finishPreparation(roomId, transaction);
      }
      return;
    }
    const videoCodec = transaction.rollback
      ? transaction.previous
      : transaction.requested;
    for (const preparation of transaction.pendingPreparations.values()) {
      if (preparation.binding.kind === "sfu") {
        continue;
      }
      this.options.sendToSession(preparation.ownerSessionId, {
        type: "video-codec-prepare",
        shareGeneration: transaction.shareGeneration,
        generation: transaction.generation,
        videoCodec,
        binding: preparation.binding,
      });
    }
  }

  private finishPreparation(roomId: string, transaction: Transaction): void {
    if (
      this.rooms.get(roomId) !== transaction ||
      transaction.phase !== "preparing"
    ) {
      return;
    }
    if (
      transaction.sfuOperationPending &&
      !this.options.parkSfuReplacement(roomId, transaction.generation)
    ) {
      this.preparationFailed(roomId, transaction);
      return;
    }
    this.clearDeadline(transaction);
    transaction.phase = transaction.rollback ? "rollback-prepared" : "prepared";
    this.sendResult(transaction.hostSessionId, {
      generation: transaction.generation,
      videoCodec: transaction.rollback
        ? transaction.previous
        : transaction.requested,
      status: transaction.rollback ? "rollback-prepared" : "prepared",
      failure: transaction.rollback ? transaction.failure : null,
    });
  }

  private preparationFailed(roomId: string, transaction: Transaction): void {
    if (this.rooms.get(roomId) !== transaction) {
      return;
    }
    this.clearDeadline(transaction);
    this.clearPendingResume(roomId);
    this.abortPendingSfuOperation(roomId, transaction);
    if (transaction.rollback) {
      this.failClosed(roomId, transaction, "rollback-failed");
      return;
    }
    transaction.failure = "preparation-failed";
    transaction.rollback = true;
    transaction.generation = this.allocateGeneration();
    transaction.targets.clear();
    this.beginTransactionPreparation(
      roomId,
      transaction,
      this.options.snapshot(roomId) ?? { revision: 0, targets: [] },
    );
  }

  private proofFailed(roomId: string, transaction: Transaction): void {
    if (this.rooms.get(roomId) !== transaction) {
      return;
    }
    this.clearDeadline(transaction);
    const pendingResume = this.pendingResumes.get(roomId);
    this.options.restoreAuthoritativePause(
      roomId,
      transaction.hostSessionId,
      transaction.shareGeneration,
      transaction.generation,
      pendingResume?.resumeAttempt ?? null,
    );
    this.clearPendingResume(roomId, pendingResume);
    this.abortPendingSfuOperation(roomId, transaction);
    if (transaction.rollback) {
      this.failClosed(roomId, transaction, "rollback-failed");
      return;
    }
    transaction.failure = "proof-failed";
    transaction.rollback = true;
    transaction.generation = this.allocateGeneration();
    transaction.targets.clear();
    this.beginTransactionPreparation(
      roomId,
      transaction,
      this.options.snapshot(roomId) ?? { revision: 0, targets: [] },
    );
  }

  private finishProof(
    roomId: string,
    transaction: Transaction,
    releaseRoutePause = true,
  ): void {
    if (this.rooms.get(roomId) !== transaction) {
      return;
    }
    this.clearDeadline(transaction);
    this.clearPendingResume(roomId);
    const committed = transaction.rollback
      ? transaction.previous
      : transaction.requested;
    this.options.commitCodec(roomId, committed);
    this.rooms.delete(roomId);
    this.sendResult(transaction.hostSessionId, {
      generation: transaction.generation,
      videoCodec: committed,
      status: "committed",
      failure: transaction.rollback ? transaction.failure : null,
    });
    if (releaseRoutePause) {
      this.options.releaseRoutePause(roomId);
    }
  }

  private failClosed(
    roomId: string,
    transaction: Transaction,
    failure: TransitionFailure,
  ): void {
    if (this.rooms.get(roomId) !== transaction) {
      return;
    }
    this.clearDeadline(transaction);
    this.clearPendingResume(roomId);
    this.abortPendingSfuOperation(roomId, transaction);
    transaction.phase = "failed";
    transaction.failure = failure;
    transaction.pendingPreparations.clear();
    transaction.pendingProofs.clear();
    transaction.proofRevision = null;
    this.sendResult(transaction.hostSessionId, {
      generation: transaction.generation,
      videoCodec: transaction.previous,
      status: "failed",
      failure,
    });
  }

  private revalidate(roomId: string, transaction: Transaction): void {
    if (this.revalidatingRoomIds.has(roomId)) {
      this.deferredRevalidationRoomIds.add(roomId);
      return;
    }
    this.revalidatingRoomIds.add(roomId);
    try {
      this.revalidateCurrentSnapshot(roomId, transaction);
    } finally {
      this.revalidatingRoomIds.delete(roomId);
    }
    if (this.deferredRevalidationRoomIds.delete(roomId)) {
      this.participantChanged(roomId);
    }
  }

  private revalidateCurrentSnapshot(
    roomId: string,
    transaction: Transaction,
  ): void {
    if (
      transaction.phase === "initializing" ||
      transaction.phase === "failed"
    ) {
      return;
    }
    const current = this.options.snapshot(roomId);
    if (!current) {
      this.invalidateAllTargets(roomId, transaction);
      return;
    }
    let changed = false;
    let lostSfuTarget = false;
    const currentByViewer = new Map(
      current.targets.map((target) => [target.viewerPeerId, target]),
    );
    const invalidatedViewerPeerIds: string[] = [];
    for (const [viewerPeerId, frozen] of transaction.targets) {
      const candidate = currentByViewer.get(viewerPeerId);
      if (!candidate || !sameTarget(frozen, candidate)) {
        transaction.targets.delete(viewerPeerId);
        transaction.pendingProofs.delete(viewerPeerId);
        invalidatedViewerPeerIds.push(viewerPeerId);
        lostSfuTarget ||= isSfuTarget(frozen);
        changed = true;
        continue;
      }
      if (
        frozen.routeRevision !== candidate.routeRevision ||
        frozen.proofReady !== candidate.proofReady
      ) {
        frozen.routeRevision = candidate.routeRevision;
        frozen.proofReady = candidate.proofReady;
        changed = true;
      }
    }
    if (
      transaction.sfuOperationPending &&
      [...transaction.targets.values()].some(
        (target) => isSfuTarget(target) && target.proofReady,
      )
    ) {
      transaction.sfuOperationPending = false;
    }
    if (lostSfuTarget && transaction.sfuOperationPending) {
      this.abortPendingSfuOperation(roomId, transaction);
      transaction.requiresSfuReplacement = false;
    }
    const pendingSfuSubtree = transaction.sfuOperationPending
      ? pendingSfuSubtreeViewerPeerIds(transaction.targets)
      : new Set<string>();
    if (transaction.phase === "proving") {
      for (const [viewerPeerId, target] of transaction.targets) {
        if (target.proofReady || pendingSfuSubtree.has(viewerPeerId)) continue;
        transaction.targets.delete(viewerPeerId);
        transaction.pendingProofs.delete(viewerPeerId);
        invalidatedViewerPeerIds.push(viewerPeerId);
        changed = true;
      }
    }
    if (transaction.phase === "preparing") {
      const stillRequired = preparationsFor(transaction.targets);
      for (const [key, preparation] of transaction.pendingPreparations) {
        const currentPreparation = stillRequired.get(key);
        if (
          !currentPreparation ||
          currentPreparation.ownerSessionId !== preparation.ownerSessionId
        ) {
          transaction.pendingPreparations.delete(key);
        }
      }
    }
    if (invalidatedViewerPeerIds.length > 0) {
      this.options.returnTargetsToRouteWait(roomId, invalidatedViewerPeerIds);
      this.refreshRetainedTargets(roomId, transaction);
    }
    if (transaction.phase === "proving" && changed) {
      transaction.proofRevision = null;
      transaction.pendingProofs = new Set(transaction.targets.keys());
      this.issueProofBatch(roomId, transaction);
    }
  }

  private invalidateAllTargets(
    roomId: string,
    transaction: Transaction,
  ): void {
    const invalidated = [...transaction.targets.keys()];
    const hadSfu = [...transaction.targets.values()].some(isSfuTarget);
    transaction.targets.clear();
    transaction.pendingPreparations.clear();
    transaction.pendingProofs.clear();
    transaction.proofRevision = null;
    if (invalidated.length > 0) {
      this.options.returnTargetsToRouteWait(roomId, invalidated);
    }
    if (hadSfu && transaction.sfuOperationPending) {
      this.abortPendingSfuOperation(roomId, transaction);
      transaction.requiresSfuReplacement = false;
    }
  }

  private refreshRetainedTargets(
    roomId: string,
    transaction: Transaction,
  ): void {
    const current = this.options.snapshot(roomId);
    if (!current) {
      return;
    }
    const currentByViewer = new Map(
      current.targets.map((target) => [target.viewerPeerId, target]),
    );
    for (const [viewerPeerId, frozen] of transaction.targets) {
      const candidate = currentByViewer.get(viewerPeerId);
      if (candidate && sameTarget(frozen, candidate)) {
        frozen.routeRevision = candidate.routeRevision;
        frozen.proofReady = candidate.proofReady;
      }
    }
  }

  private issueProofBatch(roomId: string, transaction: Transaction): void {
    const pendingResume = this.pendingResumes.get(roomId);
    if (
      transaction.phase !== "proving" ||
      !pendingResume ||
      pendingResume.hostSessionId !== transaction.hostSessionId ||
      pendingResume.shareGeneration !== transaction.shareGeneration ||
      pendingResume.codecGeneration !== transaction.generation ||
      transaction.targets.size === 0 ||
      [...transaction.targets.values()].some((target) => !target.proofReady)
    ) {
      return;
    }
    const revisions = new Set(
      [...transaction.targets.values()].map((target) => target.routeRevision),
    );
    if (revisions.size !== 1) {
      return;
    }
    const revision = revisions.values().next().value;
    if (revision === undefined || transaction.proofRevision === revision) {
      return;
    }
    transaction.proofRevision = revision;
    transaction.pendingProofs = new Set(transaction.targets.keys());
    const expectedCodec = expectedActualCodec(transaction);
    for (const target of transaction.targets.values()) {
      this.options.sendToSession(target.viewerSessionId, {
        type: "video-codec-proof-request",
        shareGeneration: transaction.shareGeneration,
        generation: transaction.generation,
        resumeAttempt: pendingResume.resumeAttempt,
        routeRevision: target.routeRevision,
        expectedCodec,
        binding: target.proofBinding,
      });
    }
  }

  private abortPendingSfuOperation(
    roomId: string,
    transaction: Transaction,
  ): void {
    if (!transaction.sfuOperationPending) return;
    transaction.sfuOperationPending = false;
    this.options.abortSfuReplacement(roomId, transaction.generation);
  }

  private beginResumeAttempt(
    input: {
      roomId: string;
      hostSessionId: string;
      shareGeneration: string;
    },
    codecGeneration: CodecTransitionGeneration | null,
  ): void {
    const resumeAttempt = this.allocateResumeAttempt();
    let pending!: PendingResume;
    const timer = setTimeout(
      () => this.resumeAttemptExpired(input.roomId, pending),
      this.timeoutMs,
    );
    pending = {
      hostSessionId: input.hostSessionId,
      shareGeneration: input.shareGeneration,
      codecGeneration,
      resumeAttempt,
      deadlineAtMs: this.now() + this.timeoutMs,
      timer,
    };
    this.pendingResumes.set(input.roomId, pending);
    this.options.authorizeResume(
      input.roomId,
      input.hostSessionId,
      input.shareGeneration,
      codecGeneration,
      resumeAttempt,
    );
  }

  private resumeAttemptExpired(roomId: string, pending: PendingResume): void {
    if (this.pendingResumes.get(roomId) !== pending) {
      return;
    }
    const transaction = this.rooms.get(roomId);
    if (
      transaction &&
      pending.codecGeneration === transaction.generation &&
      transaction.phase === "proving"
    ) {
      this.proofFailed(roomId, transaction);
      return;
    }
    this.options.restoreAuthoritativePause(
      roomId,
      pending.hostSessionId,
      pending.shareGeneration,
      pending.codecGeneration,
      pending.resumeAttempt,
    );
    this.clearPendingResume(roomId, pending);
    if (
      transaction &&
      pending.codecGeneration === transaction.generation &&
      transaction.phase === "awaiting-source"
    ) {
      transaction.pendingProofs.clear();
      transaction.proofRevision = null;
      transaction.phase = transaction.rollback
        ? "rollback-prepared"
        : "prepared";
    }
  }

  private clearPendingResume(
    roomId: string,
    expected?: PendingResume,
  ): void {
    const pending = this.pendingResumes.get(roomId);
    if (!pending || (expected && pending !== expected)) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingResumes.delete(roomId);
  }

  private allocateGeneration(): CodecTransitionGeneration {
    const generation = this.createGeneration();
    if (
      !Number.isSafeInteger(generation) ||
      generation <= this.latestGeneration
    ) {
      throw new Error("Codec transition generation must increase monotonically");
    }
    this.latestGeneration = generation;
    return generation;
  }

  private allocateResumeAttempt(): ResumeAttempt {
    const resumeAttempt = this.createResumeAttempt();
    if (
      !Number.isSafeInteger(resumeAttempt) ||
      resumeAttempt <= this.latestResumeAttempt
    ) {
      throw new Error("Resume attempt must increase monotonically");
    }
    this.latestResumeAttempt = resumeAttempt;
    return resumeAttempt;
  }

  private armDeadline(
    roomId: string,
    transaction: Transaction,
    expire: () => void,
  ): void {
    this.clearDeadline(transaction);
    transaction.timer = setTimeout(() => {
      if (this.rooms.get(roomId) === transaction) {
        transaction.timer = undefined;
        expire();
      }
    }, this.timeoutMs);
  }

  private clearDeadline(transaction: Transaction): void {
    if (transaction.timer) {
      clearTimeout(transaction.timer);
      transaction.timer = undefined;
    }
  }

  private messageOwns(
    transaction: Transaction | undefined,
    message: {
      shareGeneration: string;
      generation: CodecTransitionGeneration;
    },
  ): transaction is Transaction {
    return Boolean(
      transaction &&
        transaction.shareGeneration === message.shareGeneration &&
        transaction.generation === message.generation,
    );
  }

  private sendResult(
    hostSessionId: string,
    result: Omit<ResultMessage, "type">,
  ): void {
    this.options.sendToSession(hostSessionId, {
      type: "video-codec-result",
      ...result,
    });
  }
}

function freezeTargets(snapshot: CodecRouteSnapshot): Map<string, FrozenTarget> {
  return new Map(
    snapshot.targets.map((target) => [target.viewerPeerId, { ...target }]),
  );
}

function preparationsFor(
  targets: ReadonlyMap<string, FrozenTarget>,
): Map<string, Preparation> {
  const preparations = new Map<string, Preparation>();
  for (const target of targets.values()) {
    const key = preparationKey(target.preparationBinding);
    preparations.set(key, {
      ownerSessionId: target.preparationOwnerSessionId,
      binding: target.preparationBinding,
    });
  }
  return preparations;
}

function preparationKey(binding: CodecPreparationBinding): string {
  return binding.kind === "peer"
    ? `peer:${binding.childPeerId}:${binding.connectionId}`
    : `sfu:${binding.publicationGeneration}`;
}

function samePreparationBinding(
  left: CodecPreparationBinding,
  right: CodecPreparationBinding,
): boolean {
  return preparationKey(left) === preparationKey(right);
}

function sameProofBinding(
  left: CodecProofBinding,
  right: CodecProofBinding,
): boolean {
  return left.kind === right.kind &&
    left.connectionId === right.connectionId &&
    (left.kind === "peer" ||
      (right.kind === "sfu" &&
        left.publicationGeneration === right.publicationGeneration));
}

function sameTarget(left: FrozenTarget, right: CodecRouteTarget): boolean {
  return left.viewerSessionId === right.viewerSessionId &&
    left.preparationOwnerSessionId === right.preparationOwnerSessionId &&
    samePreparationBinding(left.preparationBinding, right.preparationBinding) &&
    sameProofBinding(left.proofBinding, right.proofBinding);
}

function isSfuTarget(target: CodecRouteTarget): boolean {
  return target.preparationBinding.kind === "sfu";
}

function pendingSfuSubtreeViewerPeerIds(
  targets: ReadonlyMap<string, FrozenTarget>,
): Set<string> {
  const subtreeViewerPeerIds = new Set<string>();
  const subtreeParentSessionIds = new Set<string>();
  for (const target of targets.values()) {
    if (!target.proofReady && isSfuTarget(target)) {
      subtreeViewerPeerIds.add(target.viewerPeerId);
      subtreeParentSessionIds.add(target.viewerSessionId);
    }
  }

  let previousSize = -1;
  while (subtreeViewerPeerIds.size !== previousSize) {
    previousSize = subtreeViewerPeerIds.size;
    for (const target of targets.values()) {
      if (
        target.preparationBinding.kind !== "peer" ||
        subtreeViewerPeerIds.has(target.viewerPeerId) ||
        !subtreeParentSessionIds.has(target.preparationOwnerSessionId)
      ) {
        continue;
      }
      subtreeViewerPeerIds.add(target.viewerPeerId);
      subtreeParentSessionIds.add(target.viewerSessionId);
    }
  }
  return subtreeViewerPeerIds;
}

function explicitCodec(
  preference: VideoCodecPreference,
): "h264" | "vp8" | null {
  return preference === "automatic" ? null : preference;
}

function expectedActualCodec(
  transaction: Pick<Transaction, "requested" | "rollback">,
): "h264" | "vp8" | null {
  return transaction.rollback ? null : explicitCodec(transaction.requested);
}

function sameResumeAttempt(
  pending: PendingResume | undefined,
  candidate: {
    hostSessionId: string;
    shareGeneration: string;
    codecGeneration: CodecTransitionGeneration | null;
    resumeAttempt: ResumeAttempt;
  },
): pending is PendingResume {
  return Boolean(
    pending &&
      pending.hostSessionId === candidate.hostSessionId &&
      pending.shareGeneration === candidate.shareGeneration &&
      pending.codecGeneration === candidate.codecGeneration &&
      pending.resumeAttempt === candidate.resumeAttempt,
  );
}
