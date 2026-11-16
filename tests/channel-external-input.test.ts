import { afterEach, expect, test, vi } from "vitest";
import { APP_PROTOCOL, ChannelApp } from "../src/client/channel/app-link";
import { CHANNEL_PROTOCOL } from "../src/client/channel/protocol";
import { DEFAULT_QUALITY_SETTINGS } from "../src/shared/protocol";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelExternalInput } from "../src/client/channel/components/ChannelExternalInput";
import { channelErrorPresentation } from "../src/client/channel/error-presentation";
import { setCopy, t } from "../src/client/ui/copy";

vi.mock("../src/client/channel/components/ChannelSettingsDialog", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/client/channel/components/ChannelSettingsDialog")>();
  return { ...actual, ChannelSettingsDialog: ({ children }: { children: ReactNode }) => createElement("div", null, children) };
});

class Socket {
  static OPEN = 1;
  static current: Socket;
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (() => void) | null;
  constructor() { Socket.current = this; }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  reply(result: unknown) { this.receive({ id: this.sent.at(-1)!.id, result }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

afterEach(() => { vi.unstubAllGlobals(); setCopy({ lang: "en" }); });
async function setup() {
  vi.stubGlobal("WebSocket", Socket);
  const app = new ChannelApp({ service: "piik-channel-app", protocol: APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL,
    token: "test-token", port: 8793 }, "site", "user", "credential", "Me", () => {}, () => {});
  const socket = Socket.current;
  socket.onopen?.(); socket.reply(null); await app.ready;
  return { app, socket };
}
async function arm(app: ChannelApp, socket: Socket, publication: string) {
  const preparing = app.prepareExternalInput(publication, "room");
  socket.reply({ endpoint: "http://127.0.0.1:8793/whip/test", token: "test-input" });
  await preparing;
}
function prepared(socket: Socket, publicationId: string) {
  const captureId = crypto.randomUUID();
  socket.receive({ type: "external_input_state", publicationId, state: "prepared", captureId,
    sessionId: crypto.randomUUID(), codec: "h264" });
  return captureId;
}

test.each(["waiting", "closed"] as const)("OBS %s retires its preparation without inventing capture audio controls", async state => {
  const { app, socket } = await setup();
  try {
    const publicationId = crypto.randomUUID();
    const arming = app.prepareExternalInput(publicationId, "room");
    const audioWhileArming = app.hasSourceAudioControl(publicationId);
    socket.reply({ endpoint: "http://127.0.0.1:8793/whip/test", token: "test-input" });
    await arming;
    expect(audioWhileArming).toBe(false);
    prepared(socket, publicationId);
    expect(app.hasSourceAudioControl(publicationId)).toBe(false);
    socket.receive({ type: "external_input_state", publicationId, state });
    expect(app.hasCapture(publicationId)).toBe(false);
    expect(app.hasSourceAudioControl(publicationId)).toBe(false);
    const commands = socket.sent.length;
    await app.cancelCapture(publicationId);
    expect(socket.sent).toHaveLength(commands);
    expect(app.externalInput(publicationId)?.state).toBe(state === "waiting" ? "waiting" : undefined);
  } finally { app.close(); }
});

test("retiring OBS permission preserves a replacement Native capture preparation", async () => {
  const { app, socket } = await setup();
  try {
    const publicationId = crypto.randomUUID();
    await arm(app, socket, publicationId);
    const preparing = app.prepareCapture(publicationId, "room", { kind: "display", sourceId: "1", title: "Display" },
      false, DEFAULT_QUALITY_SETTINGS, "h264", "auto");
    const captureId = crypto.randomUUID();
    socket.reply({ captureId, sessionId: crypto.randomUUID(), codec: "h264" });
    await preparing;
    expect(app.hasSourceAudioControl(publicationId)).toBe(true);
    const committing = app.commitCapture(publicationId, captureId);
    socket.receive({ type: "external_input_state", publicationId, state: "closed" });
    socket.reply(null); await committing;
    expect(app.hasCapture(publicationId)).toBe(true);
    expect(app.hasSourceAudioControl(publicationId)).toBe(true);
  } finally { app.close(); }
});

test.each(["zh", "en"] as const)("OBS actual format reaches one %s alert and clears on corrected input", async lang => {
  const { app, socket } = await setup();
  try {
    const independent = crypto.randomUUID();
    const preparing = app.prepareCapture(independent, "other", { kind: "display", sourceId: "1", title: "Display" },
      false, DEFAULT_QUALITY_SETTINGS, "h264", "auto");
    const captureId = crypto.randomUUID();
    socket.reply({ captureId, sessionId: crypto.randomUUID(), codec: "h264" }); await preparing;
    const committing = app.commitCapture(independent, captureId); socket.reply(null); await committing;
    const publicationId = crypto.randomUUID();
    await arm(app, socket, publicationId);
    const permit = app.externalInput(publicationId)!;
    const unsupportedVideoFormat = { codec: "h264", profileIdc: 110, constraintFlags: 0, levelIdc: 52 };
    setCopy({ lang });
    for (let attempt = 0; attempt < 3; attempt++) {
      socket.receive({ type: "external_input_state", publicationId, state: "error", error: "external_video_format_unsupported", unsupportedVideoFormat });
      const input = app.externalInput(publicationId)!;
      expect(input).toMatchObject({ endpoint: permit.endpoint, token: permit.token, unsupportedVideoFormat });
      const html = renderToStaticMarkup(createElement(ChannelExternalInput, { input, busy: false, onStop() {}, onClose() {} }));
      expect(html).toContain("High 10"); expect(html).toContain("6e0034"); expect(html).toContain("5.2");
      expect(html).toContain("NV12");
      expect(html.match(/role="alert"/g)).toHaveLength(1);
      expect(html).not.toContain("external_video_format_unsupported");
      expect(app.connected).toBe(true); expect(app.hasCapture(independent)).toBe(true);
    }
    prepared(socket, publicationId);
    expect(app.externalInput(publicationId)?.unsupportedVideoFormat).toBeUndefined();
    expect(app.externalInput(publicationId)?.error).toBeUndefined();
    socket.receive({ type: "external_input_state", publicationId, state: "waiting" });
    expect(app.externalInput(publicationId)?.unsupportedVideoFormat).toBeUndefined();
  } finally { app.close(); }
});

test("unknown profile remains numeric and a generic error ignores unrelated format detail", () => {
  const format = { codec: "h264" as const, profileIdc: 153, constraintFlags: 0, levelIdc: 52 };
  const copy = (key: Parameters<typeof t>[1], vars?: Record<string, string>) => t("en", key, vars);
  const message = channelErrorPresentation("external_video_format_unsupported", copy, undefined, format).message!;
  expect(message).toContain("profile_idc=153");
  expect(message).not.toContain("Received H.264 High 10");
  expect(channelErrorPresentation("external_input_failed", copy, undefined, format).message).not.toContain("profile_idc");
  expect(channelErrorPresentation("external_video_format_unsupported", copy, undefined,
    { ...format, levelIdc: 0 }).message).toContain("level_idc=0");
});
