import { SIGNAL_PATH, eventSchema, type Command, type Member, type PropEvent } from "./protocol";
import { RoomMedia, emptyMedia, type MediaView } from "./media";
import { BrowserShare, emptySource, type SourceView } from "./source";

export interface RoomView {
  online: boolean; self: string; members: Member[];
  media: MediaView; source: SourceView; error: string | null;
}

// One room connection owns roster, commands and media retirement. UI owns only
// local presentation (target selection and effect visibility).
export class InteractionSession {
  private socket: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private effects = new Set<(event: PropEvent) => void>();
  private state: RoomView = { online: false, self: "", members: [], media: emptyMedia, source: emptySource, error: null };
  readonly media = new RoomMedia((command) => this.send(command),
    (media) => this.set({ media }), (error) => this.set({ error }));
  readonly source = new BrowserShare((source) => {
    const previous = this.state.source;
    this.set({ source });
    if (source.stream !== previous.stream) this.media.setSource(source.stream);
    if (source.kind !== previous.kind || source.mic !== previous.mic) {
      this.send({ type: "devices", mic: source.mic, source: source.kind });
    }
  }, (error) => this.set({ error }));
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  onEffect(listener: (event: PropEvent) => void) {
    this.effects.add(listener); return () => { this.effects.delete(listener); };
  }
  private set(patch: Partial<RoomView>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((listener) => listener()); }

  connect(room: string, name: string) {
    this.close();
    this.set({ self: "", error: null });
    const url = new URL(SIGNAL_PATH, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => { if (this.socket === socket) socket.send(JSON.stringify({ type: "join", room, name })); };
    socket.onmessage = ({ data }) => {
      if (this.socket !== socket) return;
      let value: unknown;
      try { value = JSON.parse(String(data)); } catch { socket.close(); return; }
      const parsed = eventSchema.safeParse(value);
      if (!parsed.success) { socket.close(); return; }
      const event = parsed.data;
      switch (event.type) {
        case "welcome": this.set({ self: event.self, online: true }); break;
        case "members":
          this.set({ members: event.members });
          this.media.update(this.state.self, event.members);
          this.source.setOwner(event.members.some((member) => member.id === this.state.self && member.role === "host") ? this.state.self : null);
          break;
        case "prop": this.effects.forEach((listener) => listener(event)); break;
        case "signal": this.media.receive(event); break;
        case "error": this.set({ error: event.code }); break;
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.source.setOwner(null);
      this.media.close();
      this.set({ online: false, members: [], error: this.state.error === "host-left" ? "host-left" : "disconnected" });
    };
  }
  send(command: Command) {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.state.online) return false;
    this.socket.send(JSON.stringify(command)); return true;
  }
  clearError() { this.set({ error: null }); }
  close() {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.source.setOwner(null);
    this.media.close();
    this.set({ online: false, members: [] });
  }
}
