import type { BrowserCaptureSource } from "./quality";

// The Host session owns capture and lifetime. This helper owns only the raw
// audio inputs and mixer; transports borrow its single output track.
export class HostAudio {
  private source: MediaStream;
  private microphone: MediaStreamTrack | null = null;
  private context: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private inputs: MediaStreamAudioSourceNode[] = [];
  private microphoneGain: GainNode | null = null;
  private microphoneVolume = 1;
  private microphoneDevice = "";
  private closed = false;

  constructor(source: MediaStream, private changed: (enabled: boolean) => void,
    private kind: BrowserCaptureSource = "browser") {
    this.source = source;
  }

  /** Capture facts come from the input, never the mixer destination track. */
  get sourceStream(): MediaStream { return this.source; }
  get sourceKind(): BrowserCaptureSource { return this.kind; }

  attach(source: MediaStream, kind = this.kind): MediaStream {
    const previous = this.source;
    this.source = source;
    this.kind = kind;
    const output = this.compose();
    if (previous !== source) previous.getAudioTracks().forEach((track) => track.stop());
    return output;
  }

  setMicrophoneVolume(volume: number) {
    if (this.closed || !Number.isFinite(volume)) return;
    this.microphoneVolume = Math.max(0, Math.min(2, volume));
    if (this.microphoneGain && this.context) {
      this.microphoneGain.gain.setTargetAtTime(this.microphoneVolume, this.context.currentTime, 0.01);
    }
  }

  toggleMicrophone(deviceId = this.microphoneDevice): Promise<MediaStream | null> {
    return this.setMicrophone(!this.microphone?.enabled, deviceId);
  }

  async setMicrophone(enabled: boolean, deviceId: string): Promise<MediaStream | null> {
    if (this.closed) return null;
    if (!enabled || (this.microphone && deviceId === this.microphoneDevice)) {
      if (this.microphone && deviceId !== this.microphoneDevice) {
        this.microphone.stop();
        this.microphone = null;
        this.compose();
      }
      this.microphoneDevice = deviceId;
      if (this.microphone) this.microphone.enabled = enabled;
      this.changed(enabled);
      return null;
    }
    const hadContext = !!this.context;
    if (!this.context) {
      this.context = new AudioContext();
      this.destination = this.context.createMediaStreamDestination();
      this.microphoneGain = this.context.createGain();
      this.microphoneGain.gain.value = this.microphoneVolume;
      this.microphoneGain.connect(this.destination);
    }
    const resumed = this.context.resume().then(() => true, () => false);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      } });
      if (this.closed) return null;
      if (!await resumed) throw new Error("Audio context unavailable");
      if (this.closed) return null;
      const microphone = stream.getAudioTracks()[0];
      if (!microphone || microphone.readyState === "ended") throw new Error("No live microphone");
      const previous = this.microphone;
      this.microphone = microphone;
      this.microphoneDevice = deviceId;
      microphone.onended = () => {
        if (this.closed || this.microphone !== microphone) return;
        this.microphone = null;
        this.compose();
        this.changed(false);
      };
      const output = this.compose();
      previous?.stop();
      stream = null;
      this.changed(true);
      // Existing senders already borrow this destination. A device change is
      // local input work, not another media/route replacement.
      return hadContext ? null : output;
    } catch (error) {
      if (!hadContext && !this.microphone) this.closeMixer();
      throw error;
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
  }

  private compose(): MediaStream {
    if (!this.context || !this.destination) return this.source;
    this.inputs.forEach((input) => input.disconnect());
    this.inputs = [...this.source.getAudioTracks(), this.microphone]
      .filter((track): track is MediaStreamTrack => !!track && track.readyState === "live")
      .map((track) => {
        const input = this.context!.createMediaStreamSource(new MediaStream([track]));
        // Only the microphone follows the input-volume control. Source audio
        // and the Viewer's playback volume have separate owners.
        input.connect(track === this.microphone ? this.microphoneGain! : this.destination!);
        return input;
      });
    const audio = this.destination.stream.getAudioTracks()[0]!;
    audio.contentHint = "music";
    return new MediaStream([...this.source.getVideoTracks(), audio]);
  }

  private closeMixer() {
    this.inputs.forEach((input) => input.disconnect());
    this.inputs = [];
    this.microphoneGain?.disconnect();
    this.microphoneGain = null;
    this.destination?.stream.getTracks().forEach((track) => track.stop());
    void this.context?.close().catch(() => {});
    this.context = null;
    this.destination = null;
  }

  dispose() {
    this.closed = true;
    this.microphone?.stop();
    this.microphone = null;
    this.source.getAudioTracks().forEach((track) => track.stop());
    this.closeMixer();
  }
}
