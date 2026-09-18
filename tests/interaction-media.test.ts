import { afterEach, expect, test, vi } from "vitest";
import { RoomMedia } from "../src/client/prototypes/interactions/media";
import { BrowserShare, type SourceView } from "../src/client/prototypes/interactions/source";
import type { Command, Member } from "../src/client/prototypes/interactions/protocol";

afterEach(() => vi.unstubAllGlobals());
const member = (id: string, role: Member["role"]): Member => ({ id, role, name: id, mic: false, source: role === "host" ? "camera" : null });

test("a permission result arriving after room replacement is stopped, never published", async () => {
  let grant!: (stream: MediaStream) => void;
  const request = new Promise<MediaStream>((resolve) => { grant = resolve; });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => request } });
  const change = vi.fn();
  const fail = vi.fn();
  const source = new BrowserShare(change, fail);
  source.setOwner("self");
  const capture = source.share("camera");
  source.setOwner("replacement");
  const stop = vi.fn();
  grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
  await capture;
  expect(stop).toHaveBeenCalledOnce();
  expect(change.mock.calls.at(-1)?.[0]).toMatchObject({ stream: null, pending: null });
  expect(fail).not.toHaveBeenCalled();
  source.stop();
});

test("a Viewer only receives from the Host and cannot request device capture", async () => {
  const pcs: FakePC[] = [];
  class FakePC {
    localDescription: RTCSessionDescriptionInit | null = null;
    remoteDescription: RTCSessionDescriptionInit | null = null;
    connectionState = "new";
    slots: { direction: string; receiver: { track: { kind: string } }; sender: { replaceTrack: ReturnType<typeof vi.fn> } }[] = [];
    constructor() { pcs.push(this); }
    addTransceiver = vi.fn(() => { throw new Error("Answerer must adopt offered slots"); });
    async setRemoteDescription(description: RTCSessionDescriptionInit) {
      this.remoteDescription = description;
      this.slots = ["audio", "video"].map((kind) => ({ direction: "recvonly", receiver: { track: { kind } }, sender: { replaceTrack: vi.fn(async () => {}) } }));
    }
    getTransceivers() { return this.slots; }
    async createAnswer() { return { type: "answer", sdp: "answer" }; }
    async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
    close = vi.fn(() => { this.connectionState = "closed"; });
  }
  vi.stubGlobal("RTCPeerConnection", FakePC);
  vi.stubGlobal("MediaStream", class { getTracks() { return []; } });
  const getUserMedia = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const sent: Command[] = [];
  const media = new RoomMedia((command) => sent.push(command), vi.fn(), vi.fn());
  media.update("z", [member("a", "host"), member("z", "viewer"), member("other", "viewer")]);
  const source = new BrowserShare(vi.fn(), vi.fn());
  await source.toggleMicrophone();
  await source.share("camera");
  media.receive({ type: "signal", from: "a", signal: { kind: "description", type: "offer", sdp: "offer" } });
  await vi.waitFor(() => expect(sent.some((command) => command.type === "signal")).toBe(true));
  expect(pcs[0].addTransceiver).not.toHaveBeenCalled();
  expect(pcs).toHaveLength(1);
  expect(pcs[0].slots.map((slot) => slot.direction)).toEqual(["recvonly", "recvonly"]);
  expect(pcs[0].slots[0].sender.replaceTrack).not.toHaveBeenCalled();
  expect(getUserMedia).not.toHaveBeenCalled();
  media.update("z", [{ ...member("a", "host"), source: null }, member("z", "viewer")]);
  expect(pcs[0].close).not.toHaveBeenCalled();
  media.close();
  expect(pcs[0].close).toHaveBeenCalledOnce();
});

test("source replacement preserves the old share on denial; microphone failure never stops video", async () => {
  class Track {
    enabled = true;
    readyState = "live";
    onended: (() => void) | null = null;
    constructor(readonly kind: string) {}
    stop = vi.fn(() => { this.readyState = "ended"; });
  }
  class Stream {
    constructor(private tracks: Track[]) {}
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
    getVideoTracks() { return this.tracks.filter((track) => track.kind === "video"); }
  }
  const contexts: Context[] = [];
  class Context {
    output = new Stream([new Track("audio")]);
    inputs: Stream[] = [];
    constructor() { contexts.push(this); }
    createMediaStreamDestination() { return { stream: this.output }; }
    createMediaStreamSource(stream: Stream) { this.inputs.push(stream); return { connect: vi.fn(), disconnect: vi.fn() }; }
    resume = vi.fn(async () => {});
    close = vi.fn(async () => {});
  }
  vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal("AudioContext", Context);
  const camera = new Track("video");
  const screen = new Track("video");
  const screenAudio = new Track("audio");
  const microphone = new Track("audio");
  const getUserMedia = vi.fn().mockResolvedValueOnce(new Stream([camera]))
    .mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"))
    .mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"))
    .mockResolvedValueOnce(new Stream([microphone]))
    .mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia,
    getDisplayMedia: vi.fn(async () => new Stream([screen, screenAudio])),
  } });
  let state!: SourceView;
  const fail = vi.fn();
  const source = new BrowserShare((next) => { state = next; }, fail);
  source.setOwner("host");
  await source.share("camera");
  const original = state.stream;
  await source.share("camera");
  await source.toggleMicrophone();
  expect(fail).toHaveBeenCalledTimes(2);
  expect(state.stream).toBe(original);
  expect(camera.stop).not.toHaveBeenCalled();
  expect(contexts[0].close).toHaveBeenCalledOnce();
  await source.toggleMicrophone();
  expect(state.mic).toBe(true);
  const mixed = state.stream!.getAudioTracks()[0];
  await source.toggleMicrophone();
  expect(state.mic).toBe(false);
  expect(state.stream!.getAudioTracks()).toEqual([mixed]);
  await source.share("display");
  expect(state.kind).toBe("display");
  expect(state.mic).toBe(false);
  expect(state.stream!.getVideoTracks()).toEqual([screen]);
  expect(state.stream!.getAudioTracks()).toEqual([mixed]);
  expect(contexts[1].inputs.slice(-2).flatMap((stream) => stream.getAudioTracks())).toEqual([screenAudio, microphone]);
  expect(camera.stop).toHaveBeenCalledOnce();
  expect(microphone.stop).not.toHaveBeenCalled();
  // Unplugging a microphone keeps the source alive; ending video retires all inputs.
  microphone.onended!();
  await source.toggleMicrophone();
  expect(state.stream!.getAudioTracks()).toEqual([mixed]);
  expect(mixed.readyState).toBe("live");
  expect(contexts[1].close).not.toHaveBeenCalled();
  expect(screen.stop).not.toHaveBeenCalled();
  let grant!: (stream: Stream) => void;
  getUserMedia.mockImplementationOnce(() => new Promise<Stream>((resolve) => { grant = resolve; }));
  const pending = source.toggleMicrophone();
  screen.onended!();
  const lateMicrophone = new Track("audio");
  grant(new Stream([lateMicrophone]));
  await pending;
  expect(lateMicrophone.stop).toHaveBeenCalledOnce();
  expect(state.stream).toBeNull();
  expect(camera.stop).toHaveBeenCalledOnce();
  expect(screen.stop).toHaveBeenCalledOnce();
  expect(screenAudio.stop).toHaveBeenCalledOnce();
  expect(contexts[1].close).toHaveBeenCalledOnce();
  expect(mixed.readyState).toBe("ended");
});
