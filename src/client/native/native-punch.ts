import type { IceConfig, PunchPrediction, PunchSignal, SignalPayload } from "../../shared/protocol";
import { debugEvent } from "../lib/debug";
import { natPredictionSurveyUrls } from "../webrtc/nat-prediction";

const PREPARATION_TIMEOUT_MS = 3_500;

export interface NativePunchControl {
  preparePunch(shareId: string, connectionId: string, ice: IceConfig, secret: string,
    edgeCapacity?: number, sourceConnectionId?: string): Promise<PunchPrediction | null>;
  runPunch(shareId: string, connectionId: string, remote: PunchPrediction): Promise<boolean>;
  closePunch(shareId: string, connectionId: string): Promise<void>;
}

export function punchIceConfig(ice: Pick<RTCConfiguration, "iceServers"> & { natPredictionStunUrls?: readonly string[] }): IceConfig | null {
  const urls = [...natPredictionSurveyUrls(ice.iceServers, ice.natPredictionStunUrls)];
  return urls.length === 3 ? { iceServers: [{ urls }] } : null;
}

type SendPunch = (payload: SignalPayload) => boolean;

// This short preparation belongs to an existing server-issued retry. Ordinary
// ICE starts after it; only mutual success authorizes both ends to consume their
// prepared sockets. No route, media readiness, or retry authority lives here.
export class NativePunchSender {
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private finishResult: ((value: boolean) => void) | null = null;
  private prediction: Promise<PunchPrediction | null> = Promise.resolve(null);
  private local: boolean | null = null;
  private remote: boolean | null = null;
  private readyReceived = false;

  constructor(private readonly control: NativePunchControl, private readonly shareId: string,
    readonly connectionId: string, private readonly ice: IceConfig,
    private readonly send: SendPunch, private readonly sourceConnectionId?: string) {}

  start(): Promise<boolean> {
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
    return new Promise(resolve => {
      this.finishResult = resolve;
      this.timer = setTimeout(() => this.finish(false), PREPARATION_TIMEOUT_MS);
      this.prediction = this.control.preparePunch(this.shareId, this.connectionId, this.ice, secret, undefined, this.sourceConnectionId)
        .catch(() => null);
      if (!this.send({ kind: "punch", connectionId: this.connectionId, punch: { phase: "prepare", secret } })) {
        this.finish(false);
      }
    });
  }

  accept(signal: PunchSignal): void {
    if (this.closed || !this.finishResult) return;
    if (signal.phase === "ready" && !this.readyReceived) {
      this.readyReceived = true;
      if (!signal.prediction) { this.finish(false); return; }
      const remote = signal.prediction;
      void this.prediction.then(async local => {
        if (this.closed || !this.finishResult) return;
        if (!local || !this.send({ kind: "punch", connectionId: this.connectionId,
          punch: { phase: "start", prediction: local } })) {
          this.finish(false);
          return;
        }
        this.local = await this.control.runPunch(this.shareId, this.connectionId, remote).catch(() => false);
        this.maybeFinish();
      });
    } else if (signal.phase === "complete" && this.readyReceived) {
      this.remote = signal.connected;
      this.maybeFinish();
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.finish(false);
    void this.control.closePunch(this.shareId, this.connectionId).catch(() => undefined);
  }

  private maybeFinish(): void {
    if (this.local === false || this.remote === false) this.finish(false);
    else if (this.local === true && this.remote === true) this.finish(true);
  }

  private finish(value: boolean): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const resolve = this.finishResult;
    this.finishResult = null;
    if (!resolve) return;
    debugEvent("native", "punch-prepared", { connectionId: this.connectionId, connected: value });
    if (!value) void this.control.closePunch(this.shareId, this.connectionId).catch(() => undefined);
    resolve(value);
  }
}

export class NativePunchReceiver {
  private closed = false;
  private control: NativePunchControl | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ready = false;
  private started = false;
  private connected = false;

  constructor(readonly peerId: string, readonly connectionId: string,
    private readonly shareId: string, private readonly ice: IceConfig,
    private readonly capacity: number, private readonly acquire: () => Promise<NativePunchControl | null>,
    private readonly send: SendPunch) {}

  async prepare(secret: string): Promise<void> {
    this.timer = setTimeout(() => this.dispose(), PREPARATION_TIMEOUT_MS);
    const control = await this.acquire().catch(() => null);
    if (this.closed) return;
    this.control = control;
    const prediction = control
      ? await control.preparePunch(this.shareId, this.connectionId, this.ice, secret, this.capacity).catch(() => null)
      : null;
    if (this.closed) return;
    this.ready = prediction !== null;
    this.send({ kind: "punch", connectionId: this.connectionId,
      punch: { phase: "ready", ...(prediction ? { prediction } : {}) } });
    if (!prediction) this.dispose();
  }

  async run(prediction: PunchPrediction): Promise<void> {
    if (this.closed || !this.control || !this.ready || this.started) return;
    this.started = true;
    this.connected = await this.control.runPunch(this.shareId, this.connectionId, prediction).catch(() => false);
    if (this.closed) return;
    this.send({ kind: "punch", connectionId: this.connectionId,
      punch: { phase: "complete", connected: this.connected } });
    if (!this.connected) this.dispose();
  }

  // The SDP offer is the commit decision. The App's five-second resource bound
  // still applies if its browser disappears before consuming the socket.
  commit(): boolean {
    if (this.closed || !this.connected) return false;
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    return true;
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    void this.control?.closePunch(this.shareId, this.connectionId).catch(() => undefined);
  }
}
