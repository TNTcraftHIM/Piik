// The Host session owns capture and lifetime. This helper owns only the raw
// audio inputs and mixer; transports borrow its single output track.
export class HostAudio {
  private source: MediaStream;
  private microphone: MediaStreamTrack | null = null;
  private context: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private inputs: MediaStreamAudioSourceNode[] = [];
  private closed = false;

  constructor(source: MediaStream, private changed: (enabled: boolean) => void) {
    this.source = source;
  }

  attach(source: MediaStream): MediaStream {
    const previous = this.source;
    this.source = source;
    const output = this.compose();
    if (previous !== source) previous.getAudioTracks().forEach((track) => track.stop());
    return output;
  }

  async toggleMicrophone(): Promise<MediaStream | null> {
    if (this.closed) return null;
    if (this.microphone) {
      this.microphone.enabled = !this.microphone.enabled;
      this.changed(this.microphone.enabled);
      return null;
    }
    const hadContext = !!this.context;
    if (!this.context) {
      this.context = new AudioContext();
      this.destination = this.context.createMediaStreamDestination();
    }
    const resumed = this.context.resume().then(() => true, () => false);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      } });
      if (this.closed) return null;
      if (!await resumed) throw new Error("Audio context unavailable");
      if (this.closed) return null;
      const microphone = stream.getAudioTracks()[0];
      if (!microphone || microphone.readyState === "ended") throw new Error("No live microphone");
      this.microphone = microphone;
      microphone.onended = () => {
        if (this.closed || this.microphone !== microphone) return;
        this.microphone = null;
        this.compose();
        this.changed(false);
      };
      const output = this.compose();
      stream = null;
      this.changed(true);
      return output;
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
        input.connect(this.destination!); // Never monitor microphone through local speakers.
        return input;
      });
    const audio = this.destination.stream.getAudioTracks()[0]!;
    audio.contentHint = "music";
    return new MediaStream([...this.source.getVideoTracks(), audio]);
  }

  private closeMixer() {
    this.inputs.forEach((input) => input.disconnect());
    this.inputs = [];
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
