import type { SignalPayload } from "../../shared/protocol";
import { createOpaqueId } from "../lib/opaque-id";
import { browserDebugEnabled, debugError, debugEvent } from "../lib/debug";
import type { ConnectionMetrics } from "../types";
import {
  collectConnectionMetrics,
  decodedVideoFrames,
  type StatsAccumulator,
} from "../webrtc/stats";
import type { NativeClientEvent } from "./wire";

const BRIDGE_TIMEOUT_MS = 8_000;
const MAX_PENDING_CANDIDATES = 64;

export class NativeMediaBridgeError extends Error {}

export interface NativeMediaBridgeControl {
  prepareLocalEdge(
    shareId: string,
    connectionId: string,
    sourceConnectionId?: string,
  ): Promise<RTCSessionDescriptionInit>;
  acceptSignal(
    shareId: string,
    connectionId: string,
    payload: SignalPayload,
  ): Promise<void>;
  closeEdge(shareId: string, connectionId: string): Promise<void>;
  onEvent(listener: (event: NativeClientEvent) => void): () => void;
}

export class NativeMediaBridge {
  readonly stream = new MediaStream();
  readonly connectionId = createOpaqueId();

  private readonly peer = new RTCPeerConnection();
  private readonly pendingCandidates: Array<RTCIceCandidateInit | null> = [];
  private unsubscribe: (() => void) | null = null;
  private remoteDescriptionSet = false;
  private ready = false;
  private disposed = false;
  private startTimer: number | null = null;
  private rejectStart: ((error: Error) => void) | null = null;

  constructor(
    private readonly shareId: string,
    private readonly control: NativeMediaBridgeControl,
    private readonly onFailed: () => void,
    private readonly expectedAudio = false,
    private readonly sourceConnectionId?: string,
  ) {}

  collectMetrics(accumulator: StatsAccumulator): Promise<ConnectionMetrics> {
    return collectConnectionMetrics(this.peer, "receive", accumulator);
  }

  async decodedVideoFrames(): Promise<number | null> {
    const track = this.stream.getVideoTracks()[0];
    return decodedVideoFrames(
      await this.peer.getStats(),
      track ? { trackIdentifier: track.id } : null,
    );
  }

  async start(): Promise<MediaStream> {
    if (this.disposed || this.unsubscribe) {
      throw new NativeMediaBridgeError("Native media bridge is unavailable");
    }
    const started = new Promise<MediaStream>((resolve, reject) => {
      this.rejectStart = reject;
      this.startTimer = window.setTimeout(() => this.fail("timeout"), BRIDGE_TIMEOUT_MS);
      const complete = () => {
        if (
          !this.ready &&
          this.peer.connectionState === "connected" &&
          this.stream.getVideoTracks().length > 0 &&
          (!this.expectedAudio || this.stream.getAudioTracks().length > 0)
        ) {
          this.ready = true;
          this.rejectStart = null;
          this.clearStartTimer();
          resolve(this.stream);
        }
      };
      this.peer.addEventListener("track", (event) => {
        if (!this.stream.getTracks().includes(event.track)) {
          this.stream.addTrack(event.track);
        }
        complete();
      });
      this.peer.addEventListener("connectionstatechange", () => {
        debugEvent("native-bridge", "connection-state", { state: this.peer.connectionState });
        if (
          this.peer.connectionState === "failed" ||
          this.peer.connectionState === "closed"
        ) {
          this.fail("connection-state");
          return;
        }
        complete();
      });
    });
    this.peer.addEventListener("iceconnectionstatechange", () => {
      debugEvent("native-bridge", "ice-state", { state: this.peer.iceConnectionState });
    });
    this.peer.addEventListener("icegatheringstatechange", () => {
      debugEvent("native-bridge", "ice-gathering-state", { state: this.peer.iceGatheringState });
    });
    this.peer.addEventListener("icecandidate", (event) => {
      void this.control.acceptSignal(
        this.shareId,
        this.connectionId,
        {
          kind: "candidate",
          connectionId: this.connectionId,
          candidate: event.candidate
            ? {
                candidate: event.candidate.candidate,
                sdpMid: event.candidate.sdpMid,
                sdpMLineIndex: event.candidate.sdpMLineIndex,
                usernameFragment: event.candidate.usernameFragment,
              }
            : null,
        },
      ).catch(() => this.fail("candidate-signal"));
    });
    this.unsubscribe = this.control.onEvent((event) => {
      if (event.shareId !== this.shareId) return;
      if (event.type === "share-ended") {
        this.fail("share-ended");
        return;
      }
      if (
        !("connectionId" in event) ||
        event.connectionId !== this.connectionId
      ) {
        return;
      }
      if (event.type === "edge-candidate") {
        if (!this.remoteDescriptionSet) {
          if (this.pendingCandidates.length >= MAX_PENDING_CANDIDATES) {
            this.fail("candidate-overflow");
          } else {
            this.pendingCandidates.push(event.candidate);
          }
          return;
        }
        void this.peer
          .addIceCandidate(event.candidate)
          .catch(() => this.fail("candidate-apply"));
      } else if (
        event.type === "edge-state" &&
        (event.state === "failed" || event.state === "closed")
      ) {
        this.fail("native-state");
      }
    });

    const negotiate = async () => {
      const offer = await this.control.prepareLocalEdge(
        this.shareId,
        this.connectionId,
        this.sourceConnectionId,
      );
      await this.peer.setRemoteDescription(offer);
      this.remoteDescriptionSet = true;
      for (const candidate of this.pendingCandidates.splice(0)) {
        await this.peer.addIceCandidate(candidate);
      }
      const answer = await this.peer.createAnswer();
      if (!answer.sdp) {
        throw new Error("Native media bridge produced no SDP answer");
      }
      await this.peer.setLocalDescription(answer);
      await this.control.acceptSignal(
        this.shareId,
        this.connectionId,
        {
          kind: "description",
          connectionId: this.connectionId,
          description: {
            type: "answer",
            sdp: answer.sdp,
          },
        },
      );
      return await started;
    };
    try {
      return await Promise.race([negotiate(), started]);
    } catch (error) {
      this.fail("negotiation");
      throw error instanceof NativeMediaBridgeError
        ? error
        : new NativeMediaBridgeError("Native media bridge failed", { cause: error });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectStart?.(new NativeMediaBridgeError("Native media bridge failed"));
    this.rejectStart = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearStartTimer();
    this.pendingCandidates.length = 0;
    this.peer.close();
    this.stream.getTracks().forEach((track) => track.stop());
    void this.control.closeEdge(this.shareId, this.connectionId).catch(
      () => undefined,
    );
  }

  private fail(reason: string): void {
    if (this.disposed) return;
    debugEvent("native-bridge", "failed", { type: reason, state: this.ready ? "active" : "starting" });
    void this.reportFailureDiagnostics();
    if (this.ready) this.onFailed();
    this.dispose();
  }

  private async reportFailureDiagnostics(): Promise<void> {
    if (!browserDebugEnabled) return;
    try {
      debugEvent("native-bridge", "connection-state", { state: this.peer.connectionState });
      debugEvent("native-bridge", "ice-state", { state: this.peer.iceConnectionState });
      debugEvent("native-bridge", "ice-gathering-state", { state: this.peer.iceGatheringState });
      const receivers = this.peer.getReceivers();
      for (const kind of ["video", "audio"]) {
        debugEvent("native-bridge", "receiver-count", {
          type: kind, state: "live",
          count: receivers.filter((receiver) => receiver.track.kind === kind && receiver.track.readyState === "live").length,
        });
      }
      for (const transport of new Set(receivers.map((receiver) => receiver.transport))) {
        if (transport) debugEvent("native-bridge", "dtls-state", { state: transport.state });
      }
      // Start the one snapshot before disposal; it never delays the bridge deadline.
      const stats = Array.from((await this.peer.getStats()).values());
      for (const direction of ["local", "remote"]) {
        for (const type of ["host", "srflx", "prflx", "relay"]) {
          for (const protocol of ["udp", "tcp"]) {
            debugEvent("native-bridge", "candidate-count", {
              type: `${direction}-${type}`, state: protocol,
              count: stats.filter((entry) => entry.type === `${direction}-candidate` &&
                entry.candidateType === type && entry.protocol === protocol).length,
            });
          }
        }
      }
    } catch (error) {
      debugError("native-bridge", "diagnostics-failed", error);
    }
  }

  private clearStartTimer(): void {
    if (this.startTimer === null) return;
    window.clearTimeout(this.startTimer);
    this.startTimer = null;
  }
}
