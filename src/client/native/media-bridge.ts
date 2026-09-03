import type { SignalPayload } from "../../shared/protocol";
import { createOpaqueId } from "../lib/opaque-id";
import type { NativeClientEvent } from "./wire";

const BRIDGE_TIMEOUT_MS = 8_000;
const MAX_PENDING_CANDIDATES = 64;

export interface NativeMediaBridgeControl {
  prepareLocalEdge(
    shareId: string,
    connectionId: string,
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

  constructor(
    private readonly shareId: string,
    private readonly control: NativeMediaBridgeControl,
    private readonly onFailed: () => void,
    private readonly expectedAudio = false,
  ) {}

  async start(): Promise<MediaStream> {
    if (this.disposed || this.unsubscribe) {
      throw new Error("Native media bridge is unavailable");
    }
    let rejectStart: (error: Error) => void = () => undefined;
    const started = new Promise<MediaStream>((resolve, reject) => {
      rejectStart = reject;
      this.startTimer = window.setTimeout(
        () => this.fail(rejectStart),
        BRIDGE_TIMEOUT_MS,
      );
      const complete = () => {
        if (
          !this.ready &&
          this.peer.connectionState === "connected" &&
          this.stream.getVideoTracks().length > 0 &&
          (!this.expectedAudio || this.stream.getAudioTracks().length > 0)
        ) {
          this.ready = true;
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
        if (
          this.peer.connectionState === "failed" ||
          this.peer.connectionState === "closed"
        ) {
          this.fail(rejectStart);
          return;
        }
        complete();
      });
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
      ).catch(() => this.fail(rejectStart));
    });
    this.unsubscribe = this.control.onEvent((event) => {
      if (event.shareId !== this.shareId) return;
      if (event.type === "share-ended") {
        this.fail(rejectStart);
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
            this.fail(rejectStart);
          } else {
            this.pendingCandidates.push(event.candidate);
          }
          return;
        }
        void this.peer
          .addIceCandidate(event.candidate)
          .catch(() => this.fail(rejectStart));
      } else if (
        event.type === "edge-state" &&
        (event.state === "failed" || event.state === "closed")
      ) {
        this.fail(rejectStart);
      }
    });

    const negotiate = async () => {
      const offer = await this.control.prepareLocalEdge(
        this.shareId,
        this.connectionId,
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
      this.dispose();
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
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

  private fail(rejectStart: (error: Error) => void): void {
    if (this.disposed) return;
    if (this.ready) {
      this.onFailed();
    } else {
      rejectStart(new Error("Native media bridge failed"));
    }
    this.dispose();
  }

  private clearStartTimer(): void {
    if (this.startTimer === null) return;
    window.clearTimeout(this.startTimer);
    this.startTimer = null;
  }
}
