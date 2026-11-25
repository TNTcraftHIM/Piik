import type { HostedRoom } from "../../../prototype/channel-browser/src/hosting-contract";
import { loadRoomHosting, roomDatabaseName } from "./hosting";
import type { ChannelCommand, ChannelSnapshot, RoomSummary } from "./protocol";
import { roomOpenFailure, type ChannelView, type RoomOpenFailure } from "./types";

/** What hosting uses from the session, which keeps the connection, the request correlator and the view. */
export interface HostingSession {
  view(): ChannelView;
  /** The connection now carrying the session: a host's late result is dropped once it changes. */
  socket(): WebSocket | null;
  request(command: ChannelCommand): Promise<void>;
  write(command: ChannelCommand): void;
  report(error: string): void;
  /** Publishes the stored rooms this Browser could not open, and why. */
  failures(failures: ReadonlyMap<string, RoomOpenFailure>): void;
}

export async function browserRoomStorage(channelId: string, userId: string) {
  const runtime = await loadRoomHosting(), database = roomDatabaseName(channelId, userId);
  return {
    storedRoomIds: () => runtime.BrowserRoomHost.storedRoomIds(database),
    openExisting: (id: string) => runtime.BrowserRoomHost.openExisting(database, id),
    open: (policy: string) => runtime.BrowserRoomHost.open(database, policy),
  };
}

/**
 * The rooms this Browser session hosts. It owns each open host and the binding the domain gave it,
 * the stored rooms it could not open, and the closing of retired hosts, which it awaits before it
 * opens rooms again.
 */
export class BrowserHosting {
  private readonly rooms = new Map<string, { host: HostedRoom; bindingId?: string }>();
  private failed: ReadonlyMap<string, RoomOpenFailure> = new Map();
  private cleanup: Promise<void> = Promise.resolve();

  constructor(private readonly session: HostingSession) {}

  /** The host of this room; when a binding is given, only while it serves that binding. */
  host(roomId: string, bindingId?: string): HostedRoom | undefined {
    const hosted = this.rooms.get(roomId);
    return hosted && (bindingId === undefined || hosted.bindingId === bindingId) ? hosted.host : undefined;
  }

  /** The domain bound this room's host. A binding that fails retires the host. */
  bound(roomId: string, bindingId: string): void {
    const hosted = this.rooms.get(roomId), socket = this.session.socket();
    if (!hosted) return;
    hosted.bindingId = bindingId;
    // bind and later dispatch share this host's existing serialized storage turn.
    void hosted.host.bind(bindingId).catch(error => {
      if (this.rooms.get(roomId) === hosted && hosted.bindingId === bindingId && this.session.socket() === socket) {
        this.rooms.delete(roomId);
        this.session.write({ type: "host_stop", roomId, bindingId });
        this.retire(hosted.host);
        this.session.report(error instanceof Error ? error.message : "room_host_failed");
      }
    });
  }

  /** Runs the domain's input on the host it is bound to. A deletion that removed the room's data retires the host. */
  input(roomId: string, input: { bindingId: string }): void {
    const hosted = this.rooms.get(roomId), socket = this.session.socket();
    if (!hosted || hosted.bindingId !== input.bindingId) return;
    const binding = hosted.bindingId;
    const current = () => this.rooms.get(roomId) === hosted && hosted.bindingId === binding && this.session.socket() === socket;
    void hosted.host.dispatch(input).then(output => {
      if (!current()) return;
      const result = (output as { reply?: { result?: { type?: string; dataRemoved?: boolean } } }).reply?.result;
      if (result?.type === "deleted" && result.dataRemoved === true) {
        this.rooms.delete(roomId);
        this.retire(hosted.host);
      }
      this.session.write({ type: "host_output", roomId, output });
    }).catch(error => {
      if (current()) this.session.report(error instanceof Error ? error.message : "room_host_failed");
    });
  }

  /** Follows an authority snapshot: a room the directory no longer lists is no longer hosted or reported here. */
  update(state: ChannelSnapshot): void {
    const listed = (id: string) => state.channel.rooms.some(room => room.id === id);
    for (const [id, hosted] of this.rooms) if (!listed(id)) {
      this.rooms.delete(id);
      this.retire(hosted.host);
    }
    for (const id of this.failed.keys()) if (!listed(id)) this.fail(id);
  }

  /**
   * Opens and registers each stored room this user created that the directory lists, except `skipRoom`,
   * retires hosts whose room is no longer stored, and withdraws this session's bindings that no host
   * serves. `current` holds while the connection and session that asked are live.
   */
  async restore(sessionId: string, current: () => boolean, skipRoom?: string): Promise<void> {
    if (typeof indexedDB === "undefined") return;
    await this.cleanup;
    if (!current()) return;
    const { state, self } = this.session.view();
    if (!state || !self) return;
    const storage = await browserRoomStorage(state.channel.id, self.id);
    const retained = new Set(await storage.storedRoomIds());
    if (!current()) return;
    for (const id of this.failed.keys()) if (!retained.has(id)) this.fail(id);
    for (const [id, hosted] of this.rooms) if (!retained.has(id)) {
      if (!current()) return;
      this.rooms.delete(id);
      await hosted.host.close();
    }
    for (const id of retained) {
      if (!current()) return;
      if (id === skipRoom) continue;
      if (!this.session.view().state?.channel.rooms.some(room => room.id === id && room.creatorId === self.id)) continue;
      let hosted = this.rooms.get(id);
      let room: RoomSummary;
      try {
        if (!hosted) {
          const host = await storage.openExisting(id);
          if (!current()) { await host.close(); return; }
          hosted = { host };
          this.rooms.set(id, hosted);
        }
        room = await hosted.host.summary();
        if (room.creatorId !== self.id) throw new Error("owner_mismatch");
      } catch (error) {
        if (!current()) return;
        if (this.rooms.get(id) !== hosted) continue;
        if (hosted) {
          this.rooms.delete(id);
          await hosted.host.close();
        }
        this.fail(id, error instanceof Error && error.message === "room_not_found" ? undefined : roomOpenFailure(error));
        continue;
      }
      if (!current()) return;
      if (this.rooms.get(id) !== hosted) continue;
      this.fail(id);
      try { await this.session.request({ type: "host_register", room, resumeBinding: hosted.bindingId }); }
      catch (error) {
        if (!current()) return;
        if (!(error instanceof Error) || !["room_not_in_domain", "room_already_hosted", "room_creation_restricted"].includes(error.message)) throw error;
        if (this.rooms.get(id) !== hosted) continue;
        this.rooms.delete(id);
        await hosted.host.close();
      }
    }
    if (!current()) return;
    for (const room of this.session.view().state?.channel.rooms ?? []) {
      if (room.delivery?.hostSessionId === sessionId && !this.rooms.has(room.id)) {
        this.session.write({ type: "host_stop", roomId: room.id, bindingId: room.delivery.bindingId });
      }
    }
  }

  /** Holds a host the session just opened and registers it. `current` throws once the session that opened it is gone. */
  async register(roomId: string, host: HostedRoom, current: () => void): Promise<void> {
    try { current(); } catch (error) { await host.close(); throw error; }
    this.rooms.set(roomId, { host });
    this.fail(roomId);
    const summary = await host.summary();
    current();
    if (this.rooms.get(roomId)?.host !== host) throw new Error("disconnected");
    await this.session.request({ type: "host_register", room: summary });
  }

  /** Keeps this room's host serving until `commit` replaces its durable writer, then retires it unless it already left. */
  async replace(roomId: string, commit: () => Promise<void>): Promise<void> {
    const hosted = this.rooms.get(roomId);
    await commit();
    if (hosted && this.rooms.get(roomId) === hosted) {
      this.rooms.delete(roomId);
      if (hosted.bindingId) this.session.write({ type: "host_stop", roomId, bindingId: hosted.bindingId });
      await hosted.host.close();
    }
  }

  /** Ends hosting for this session. `stop` first withdraws each bound room, for a session that leaves on a live connection. */
  release(stop = false): void {
    if (stop) for (const [roomId, hosted] of this.rooms) if (hosted.bindingId) this.session.write({ type: "host_stop", roomId, bindingId: hosted.bindingId });
    const hosts = [...this.rooms.values()];
    this.rooms.clear();
    if (this.failed.size) {
      this.failed = new Map();
      this.session.failures(this.failed);
    }
    this.retire(...hosts.map(value => value.host));
  }

  /** The stored room's reason it could not open; an omitted failure clears it. */
  private fail(roomId: string, failure?: RoomOpenFailure): void {
    if (this.failed.get(roomId) === failure) return;
    const failed = new Map(this.failed);
    if (failure) failed.set(roomId, failure);
    else failed.delete(roomId);
    this.failed = failed;
    this.session.failures(failed);
  }

  private retire(...hosts: HostedRoom[]): void {
    this.cleanup = Promise.all([this.cleanup, ...hosts.map(host => host.close())]).then(() => {});
  }
}
