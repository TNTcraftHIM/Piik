import { EncryptedInput, type InputPacket, type InputTransport } from "../remote-control/input-route";
import { loadRoomHosting } from "./hosting";
import type { ChannelCommand, ChannelSnapshot } from "./protocol";

type Runtime = Awaited<ReturnType<typeof loadRoomHosting>>;
interface Context { sessionId: string | null; state: ChannelSnapshot | null; connected: boolean }
interface Frame {
  publicationId: string; controllerSessionId: string; routeId: string; flowId: string;
  data?: InputPacket; closed?: true; ready?: true;
}
interface Hop { pairId: string; peerId: string; flowId: string }
interface Binding {
  publicationId: string; controllerSessionId: string; routeId: string;
  upstream: Hop | null; downstream: Hop | null;
}
interface Routed { frame: Frame; route: { nextHop: string | null; binding: Binding } }
interface Endpoint { pairId: string; flowId: string; channel: EncryptedInput }

/** Page-owned encrypted endpoints; shared Rust owns every committed hop. */
export class ChannelInput {
  private channels = new Map<string, { channel: RTCDataChannel; remove(): void }>();
  private endpoints = new Map<string, Endpoint>();
  private bindings = new Map<string, Binding>();
  private runtime: Runtime | undefined;
  private loading: Promise<Runtime> | undefined;

  constructor(private options: {
    context(): Context;
    register(command: Extract<ChannelCommand, { type: "input_register" }>): void;
    send(peer: string, frame: string): boolean;
    changed(channels: ReadonlyMap<string, InputTransport>): void;
  }) {}

  setChannel(pairId: string, channel: RTCDataChannel | null): void {
    if (this.channels.get(pairId)?.channel === channel) return;
    if (this.channels.has(pairId)) this.retirePair(pairId);
    this.channels.get(pairId)?.remove();
    this.channels.delete(pairId);
    if (channel) {
      const message = (event: MessageEvent) => {
        if (typeof event.data !== "string" || event.data.length > 8192) return;
        void this.receive(pairId, channel, event.data).catch(() => { /* Invalid input has no authority. */ });
      };
      const refresh = () => this.update();
      const closed = () => { if (this.channels.get(pairId)?.channel === channel) this.setChannel(pairId, null); };
      channel.addEventListener("message", message);
      channel.addEventListener("open", refresh);
      channel.addEventListener("close", closed);
      this.channels.set(pairId, { channel, remove: () => {
        channel.removeEventListener("message", message);
        channel.removeEventListener("open", refresh);
        channel.removeEventListener("close", closed);
      } });
    }
    this.update();
  }

  private retirePair(pairId: string): void {
    const { sessionId, state } = this.options.context();
    for (const [key, binding] of this.bindings) {
      const hops = [binding.upstream, binding.downstream].filter((hop): hop is Hop => hop !== null);
      if (!hops.some(hop => hop.pairId === pairId)) continue;
      if (sessionId && state && this.runtime?.input_binding_current(JSON.stringify(binding), sessionId, JSON.stringify(state))) {
        for (const hop of hops) if (hop.pairId !== pairId && this.channels.get(hop.pairId)?.channel.readyState === "open") {
          this.options.send(hop.peerId, JSON.stringify({ publicationId: binding.publicationId,
            controllerSessionId: binding.controllerSessionId, routeId: binding.routeId, flowId: hop.flowId, closed: true } satisfies Frame));
        }
      }
      this.bindings.delete(key);
    }
    for (const endpoint of this.endpoints.values()) if (endpoint.pairId === pairId) endpoint.channel.close();
  }

  update(): void {
    const { sessionId, state, connected } = this.options.context();
    let changed = false;
    const selected = new Map<string, { pairId: string; flowId: string }>();
    if (sessionId && state) for (const pair of state.pairs) {
      if (this.channels.get(pair.id)?.channel.readyState !== "open") continue;
      for (const flow of pair.incoming) if (flow.selected && state.subscriptions.includes(flow.publicationId)
        && state.publications.some(publication => publication.id === flow.publicationId && publication.kind === "screen")) {
        selected.set(flow.publicationId, { pairId: pair.id, flowId: flow.id });
      }
    }
    for (const [id, endpoint] of this.endpoints) {
      const flow = selected.get(id);
      if (flow?.pairId === endpoint.pairId && flow.flowId === endpoint.flowId && endpoint.channel.readyState !== "closed") continue;
      endpoint.channel.close();
      this.endpoints.delete(id);
      changed = true;
    }
    for (const [publicationId, flow] of selected) if (connected && !this.endpoints.has(publicationId)) {
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const identity = { endpointId: sessionId!.replaceAll("-", ""),
        secret: Array.from(secret, byte => byte.toString(16).padStart(2, "0")).join("") };
      const channel = new EncryptedInput(identity, { sent: 0n }, packet => {
        this.transmit({ publicationId, controllerSessionId: sessionId!, routeId: flow.flowId, flowId: flow.flowId,
          ...(packet.closed ? { closed: true as const } : { data: packet }) },
        () => this.endpoints.get(publicationId)?.channel === channel);
      }, flow.flowId.replaceAll("-", ""));
      this.endpoints.set(publicationId, { ...flow, channel });
      this.options.register({ type: "input_register", publicationId, flowId: flow.flowId, secret: Array.from(secret) });
      changed = true;
    }
    if (sessionId && state && this.runtime) for (const [key, binding] of this.bindings) {
      if (!this.runtime.input_binding_current(JSON.stringify(binding), sessionId, JSON.stringify(state))) this.bindings.delete(key);
    }
    if (changed) this.options.changed(new Map([...this.endpoints].map(([id, endpoint]) => [id, endpoint.channel])));
  }

  private async ready(): Promise<Runtime> {
    this.loading ??= loadRoomHosting();
    return this.runtime ??= await this.loading;
  }

  private key(frame: Frame): string { return `${frame.publicationId}:${frame.controllerSessionId}`; }

  private route(runtime: Runtime, frame: Frame, from?: string): Routed | null {
    const { sessionId, state } = this.options.context();
    if (!sessionId || !state) return null;
    const key = this.key(frame), binding = this.bindings.get(key);
    const routed = JSON.parse(runtime.route_input(JSON.stringify(frame), sessionId, JSON.stringify(state), from,
      binding === undefined ? undefined : JSON.stringify(binding))) as Routed;
    if (routed.route.binding) this.bindings.set(key, routed.route.binding);
    if (frame.closed) this.bindings.delete(key);
    return routed;
  }

  private transmit(frame: Frame, owns: () => boolean): void {
    const send = (runtime: Runtime) => {
      if (!owns()) return;
      try {
        const routed = this.route(runtime, frame);
        if (routed?.route.nextHop) this.options.send(routed.route.nextHop, JSON.stringify(routed.frame));
      } catch { /* A retired route cannot send input. */ }
    };
    if (this.runtime) send(this.runtime);
    else void this.ready().then(send).catch(() => {});
  }

  private async receive(pairId: string, channel: RTCDataChannel, data: string): Promise<void> {
    const runtime = await this.ready();
    const context = this.options.context();
    if (this.channels.get(pairId)?.channel !== channel) return;
    const pair = context.state?.pairs.find(pair => pair.id === pairId);
    if (!pair) return;
    const frame = JSON.parse(data) as Frame;
    const routed = this.route(runtime, frame, pair.peerId);
    if (!routed || this.channels.get(pairId)?.channel !== channel) return;
    if (routed.route.nextHop) {
      const current = this.options.context();
      if (current.sessionId && current.state && runtime.input_binding_current(JSON.stringify(routed.route.binding), current.sessionId, JSON.stringify(current.state))) {
        this.options.send(routed.route.nextHop, JSON.stringify(routed.frame));
      }
      return;
    }
    const endpoint = this.endpoints.get(frame.publicationId);
    if (!endpoint || frame.controllerSessionId !== context.sessionId || frame.routeId !== endpoint.flowId) return;
    if (frame.ready) endpoint.channel.send(JSON.stringify({ type: "sync" }));
    else if (frame.closed) endpoint.channel.close();
    else if (frame.data) {
      const packet = frame.data;
      if (packet.id === context.sessionId?.replaceAll("-", "") && packet.epoch === endpoint.channel.epoch && packet.data) endpoint.channel.receive(packet.data);
    }
  }

  reset(): void {
    for (const endpoint of this.endpoints.values()) endpoint.channel.close();
    this.endpoints.clear();
    for (const channel of this.channels.values()) channel.remove();
    this.channels.clear();
    this.bindings.clear();
    this.options.changed(new Map());
  }
}
