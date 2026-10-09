import type { SignalPayload } from "../../shared/protocol";
import { createOpaqueId } from "../lib/opaque-id";
import { browserDebugEnabled, debugError, debugEvent } from "../lib/debug";
import { observeDebugConnection } from "../lib/debug-webrtc";
import type { ConnectionMetrics } from "../types";
import { preferScreenAudioStereo } from "../webrtc/screen-audio-sdp";
import {
  collectConnectionMetrics,
  decodedVideoFrames,
  type StatsAccumulator,
} from "../webrtc/stats";
import type { NativeClientEvent } from "./wire";

const BRIDGE_TIMEOUT_MS = 8_000;
const DISCONNECTED_GRACE_MS = 3_000;

export class NativeMediaBridgeError extends Error {}
export class NativeMediaBridgeInitializationError extends NativeMediaBridgeError {}

export interface NativeMediaBridgeControl {
  prepareLocalEdge(
    shareId: string,
    connectionId: string,
    sourceConnectionId?: string,
    restart?: boolean,
  ): Promise<RTCSessionDescriptionInit & { offerId: string }>;
  acceptSignal(
    shareId: string,
    connectionId: string,
    payload: SignalPayload,
    offerId?: string,
  ): Promise<void>;
  closeEdge(shareId: string, connectionId: string): Promise<void>;
  onEvent(listener: (event: NativeClientEvent) => void): () => void;
}

export class NativeMediaBridge {
  readonly stream: MediaStream;
  readonly connectionId = createOpaqueId();

  private readonly peer: RTCPeerConnection;
  private readonly lifetime = new AbortController();
  private unsubscribe: (() => void) | null = null;
  private edgeRequested = false;
  private ready = false;
  private disposed = false;
  private expectedAudio = false;
  private deadline: number | null = null;
  private disconnectTimer: number | null = null;
  private completeNegotiation: (() => void) | null = null;
  private rejectNegotiation: ((error: Error) => void) | null = null;

  constructor(
    private readonly shareId: string,
    private readonly control: NativeMediaBridgeControl,
    private readonly onFailed: () => void,
    private readonly sourceConnectionId?: string,
  ) {
    let peer: RTCPeerConnection | undefined;
    try {
      this.stream = new MediaStream();
      this.peer = peer = new RTCPeerConnection();
      observeDebugConnection(this.peer, { connectionId: this.connectionId, sourceConnectionId, shareId, role: "native-preview" });
    } catch (error) {
      peer?.close();
      debugError("native-bridge", "initialization-failed", error);
      throw new NativeMediaBridgeInitializationError("Native media bridge could not initialize", { cause: error });
    }
  }

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

  async start(expectedAudio = false): Promise<MediaStream> {
    if (this.disposed || this.unsubscribe) {
      throw new NativeMediaBridgeError("Native media bridge is unavailable");
    }
    this.expectedAudio = expectedAudio;
    this.peer.addEventListener("track", (event) => {
      if (this.disposed) return;
      if (!this.stream.getTracks().includes(event.track)) this.stream.addTrack(event.track);
      this.completeNegotiation?.();
    });
    this.peer.addEventListener("connectionstatechange", () => {
      debugEvent("native-bridge", "connection-state", { state: this.peer.connectionState });
      this.connectionStateChanged(this.peer.connectionState);
      this.completeNegotiation?.();
    });
    this.peer.addEventListener("iceconnectionstatechange", () => {
      debugEvent("native-bridge", "ice-state", { state: this.peer.iceConnectionState });
    });
    this.peer.addEventListener("icegatheringstatechange", () => {
      debugEvent("native-bridge", "ice-gathering-state", { state: this.peer.iceGatheringState });
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
      if (event.type === "edge-state") this.connectionStateChanged(event.state);
    });
    return this.negotiate(false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.rejectNegotiation?.(new NativeMediaBridgeError("Native media bridge failed"));
    this.rejectNegotiation = null;
    this.completeNegotiation = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearDeadline();
    this.clearDisconnectTimer();
    this.peer.close();
    this.stream.getTracks().forEach((track) => track.stop());
    if (this.edgeRequested) {
      void this.control.closeEdge(this.shareId, this.connectionId).catch(
        () => undefined,
      );
    }
  }

  private connectionStateChanged(state: RTCPeerConnectionState): void {
    if (this.disposed) return;
    if (state === "closed" || (!this.ready && state === "failed")) {
      this.fail("connection-state");
      return;
    }
    if (state === "connected") {
      if (this.peer.connectionState === "connected") this.clearDisconnectTimer();
      return;
    }
    if (!this.ready || this.completeNegotiation) return;
    const restart = () => {
      this.clearDisconnectTimer();
      if (this.disposed || this.completeNegotiation) return;
      debugEvent("native-bridge", "restart");
      void this.negotiate(true).catch(() => undefined);
    };
    if (state === "failed") restart();
    else if (state === "disconnected" && this.disconnectTimer === null) {
      this.disconnectTimer = window.setTimeout(restart, DISCONNECTED_GRACE_MS);
    }
  }

  private negotiate(restart: boolean): Promise<MediaStream> {
    return new Promise((resolve, reject) => {
      let signaled = false;
      this.rejectNegotiation = reject;
      this.deadline = window.setTimeout(() => this.fail("timeout"), BRIDGE_TIMEOUT_MS);
      this.completeNegotiation = () => {
        if (!signaled || this.disposed || this.peer.connectionState !== "connected" ||
            this.stream.getVideoTracks().length === 0 ||
            (this.expectedAudio && this.stream.getAudioTracks().length === 0)) return;
        // This proves the local transport. First-frame/playback owners still
        // prove media progress; an intentionally paused source can remain quiet.
        this.ready = true;
        this.completeNegotiation = null;
        this.rejectNegotiation = null;
        this.clearDeadline();
        resolve(this.stream);
      };
      void this.exchangeDescriptions(restart).then(() => {
        signaled = true;
        this.completeNegotiation?.();
      }).catch(error => this.fail("negotiation", error));
    });
  }

  private async exchangeDescriptions(restart: boolean): Promise<void> {
    this.edgeRequested = true;
    const { offerId, ...offer } = await this.control.prepareLocalEdge(
      this.shareId, this.connectionId, this.sourceConnectionId, restart,
    );
    this.lifetime.signal.throwIfAborted();
    await this.peer.setRemoteDescription(offer);
    this.lifetime.signal.throwIfAborted();
    const answer = preferScreenAudioStereo(await this.peer.createAnswer());
    this.lifetime.signal.throwIfAborted();
    await this.peer.setLocalDescription(answer);
    await this.gatherCandidates();
    this.lifetime.signal.throwIfAborted();
    const sdp = this.peer.localDescription?.sdp;
    if (!sdp) throw new Error("Native media bridge produced no SDP answer");
    await this.control.acceptSignal(this.shareId, this.connectionId, {
      kind: "description", connectionId: this.connectionId,
      description: { type: "answer", sdp },
    }, offerId);
  }

  private gatherCandidates(): Promise<void> {
    const signal = this.lifetime.signal;
    signal.throwIfAborted();
    if (this.peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.peer.removeEventListener("icegatheringstatechange", complete);
        signal.removeEventListener("abort", aborted);
      };
      const complete = () => {
        if (this.peer.iceGatheringState !== "complete") return;
        cleanup();
        resolve();
      };
      const aborted = () => { cleanup(); reject(signal.reason); };
      this.peer.addEventListener("icegatheringstatechange", complete);
      signal.addEventListener("abort", aborted, { once: true });
    });
  }

  private fail(reason: string, error?: unknown): void {
    if (this.disposed) return;
    const details = { type: reason, state: this.ready ? "active" : "starting" };
    if (error === undefined) debugEvent("native-bridge", "failed", details);
    else debugError("native-bridge", "failed", error, details);
    void this.reportFailureDiagnostics();
    this.rejectNegotiation?.(new NativeMediaBridgeError("Native media bridge failed", { cause: error }));
    this.rejectNegotiation = null;
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

  private clearDeadline(): void {
    if (this.deadline === null) return;
    window.clearTimeout(this.deadline);
    this.deadline = null;
  }

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer === null) return;
    window.clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }
}
