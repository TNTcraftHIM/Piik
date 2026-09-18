import { captureDisplay, QUALITY_PROFILES } from "../../media/quality";
import type { SourceKind } from "./protocol";

export interface SourceView {
  kind: SourceKind | null;
  stream: MediaStream | null;
  mic: boolean;
  pending: SourceKind | "microphone" | null;
}
export const emptySource: SourceView = { kind: null, stream: null, mic: false, pending: null };
type Mixer = { context: AudioContext; destination: MediaStreamAudioDestinationNode; inputs: MediaStreamAudioSourceNode[] };
type CaptureFailure = "permission" | "device-unavailable" | "screen-unavailable";

// One Host source owns permissions, raw devices and mixed output. Transport
// borrows its tracks; retiring a peer must never stop the shared source.
export class BrowserShare {
  private owner: string | null = null;
  private generation = 0;
  private capture: MediaStream | null = null;
  private microphone: MediaStreamTrack | null = null;
  private mixer: Mixer | null = null;
  private state: SourceView = emptySource;

  constructor(private change: (state: SourceView) => void, private fail: (code: CaptureFailure) => void) {}
  private publish(patch: Partial<SourceView> = {}) {
    this.state = { ...this.state, ...patch, mic: !!this.microphone?.enabled };
    this.change(this.state);
  }
  setOwner(id: string | null) {
    if (this.owner === id) return;
    this.owner = id;
    this.stop();
  }

  async share(kind: SourceKind) {
    if (!this.owner || this.state.pending) return;
    if (kind === "display" && !navigator.mediaDevices?.getDisplayMedia) { this.fail("screen-unavailable"); return; }
    const generation = this.generation;
    this.publish({ pending: kind });
    let stream: MediaStream | null = null;
    try {
      stream = kind === "display" ? await captureDisplay(QUALITY_PROFILES["720p30"])
        : await navigator.mediaDevices.getUserMedia({ audio: false, video: {
          facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 },
        } });
      if (this.generation !== generation) return;
      const video = stream.getVideoTracks()[0];
      if (!video || video.readyState === "ended") throw new Error("No live video source");
      video.contentHint = "motion";
      const previous = this.capture;
      const accepted = stream;
      this.capture = accepted;
      video.onended = () => { if (this.capture === accepted) this.stop(); };
      for (const audio of accepted.getAudioTracks()) {
        audio.onended = () => { if (this.capture === accepted) this.compose(); };
      }
      this.state = { ...this.state, kind };
      this.compose();
      stream = null;
      previous?.getTracks().forEach((track) => track.stop());
    } catch (error) {
      if (this.generation === generation) this.captureFailed(error);
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      if (this.generation === generation) this.publish({ pending: null });
    }
  }

  async toggleMicrophone() {
    if (!this.owner || !this.capture || this.state.pending) return;
    if (this.microphone) {
      this.microphone.enabled = !this.microphone.enabled;
      this.publish();
      return;
    }
    const generation = this.generation;
    this.publish({ pending: "microphone" });
    const hadMixer = !!this.mixer;
    let stream: MediaStream | null = null;
    try {
      // Resume within the click gesture, before awaiting device permission.
      if (!this.mixer) {
        const context = new AudioContext();
        this.mixer = { context, destination: context.createMediaStreamDestination(), inputs: [] };
      }
      const mixer = this.mixer;
      const resumed = mixer.context.resume().then(() => true, () => false);
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      } });
      if (this.generation !== generation) return;
      if (!await resumed) throw new Error("Audio context unavailable");
      if (this.generation !== generation) return;
      const microphone = stream.getAudioTracks()[0];
      if (!microphone || microphone.readyState === "ended") throw new Error("No live microphone");
      this.microphone = microphone;
      microphone.onended = () => {
        if (this.microphone !== microphone) return;
        this.microphone = null;
        this.compose();
      };
      this.compose();
      stream = null;
    } catch (error) {
      if (this.generation === generation) {
        if (!hadMixer && !this.microphone) this.closeMixer();
        this.captureFailed(error);
      }
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      if (this.generation === generation) this.publish({ pending: null });
    }
  }

  private captureFailed(error: unknown) {
    this.fail(error instanceof DOMException && error.name === "NotAllowedError" ? "permission" : "device-unavailable");
  }
  private compose() {
    const video = this.capture?.getVideoTracks()[0];
    const sourceAudio = this.capture?.getAudioTracks().find((track) => track.readyState === "live");
    const mixer = this.mixer;
    if (mixer) {
      mixer.inputs.forEach((input) => input.disconnect());
      mixer.inputs = [sourceAudio, this.microphone].filter((track): track is MediaStreamTrack => !!track).map((track) => {
        const input = mixer.context.createMediaStreamSource(new MediaStream([track]));
        // The mixed track is sent only to Viewers, never to the Host's speakers.
        input.connect(mixer.destination);
        return input;
      });
    }
    const audio = mixer?.destination.stream.getAudioTracks()[0] ?? sourceAudio;
    this.publish({ stream: video ? new MediaStream(audio ? [video, audio] : [video]) : null });
  }
  private closeMixer() {
    const mixer = this.mixer;
    this.mixer = null;
    if (!mixer) return;
    mixer.inputs.forEach((input) => input.disconnect());
    mixer.destination.stream.getTracks().forEach((track) => track.stop());
    void mixer.context.close().catch(() => {});
  }
  stop() {
    this.generation++;
    this.capture?.getTracks().forEach((track) => track.stop());
    this.microphone?.stop();
    this.capture = null;
    this.microphone = null;
    this.closeMixer();
    this.state = emptySource;
    this.publish();
  }
}
