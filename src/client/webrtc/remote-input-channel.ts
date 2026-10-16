// Both Browser reception and the App's local playback bridge announce the
// same optional capability. Their media owner still owns the PeerConnection.
export class RemoteInputChannel {
  current: RTCDataChannel | null = null;
  private connection: RTCPeerConnection | null = null;

  constructor(private readonly changed: () => void) {}

  attach(connection: RTCPeerConnection): void {
    this.dispose();
    this.connection = connection;
    connection.addEventListener("datachannel", ({ channel }) => {
      if (this.connection !== connection || channel.label !== "piik-remote-input-prototype-v1" || this.current) {
        channel.close();
        return;
      }
      this.current = channel;
      channel.addEventListener("open", () => {
        if (this.current === channel) this.changed();
      });
      channel.addEventListener("close", () => {
        if (this.current === channel) {
          this.current = null;
          this.changed();
        }
      });
      if (channel.readyState === "open") this.changed();
    });
  }

  dispose(): void {
    this.connection = null;
    const channel = this.current;
    this.current = null;
    channel?.close();
  }
}
