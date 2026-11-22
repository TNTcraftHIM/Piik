import { afterEach, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelActivityIndicators, ChannelUser } from "../src/client/channel/components/ChannelUser";
import { ChannelCouch } from "../src/client/channel/components/ChannelCouch";
import { Glyph, type GlyphName } from "../src/client/ui/icons";
import { setCopy, type Lang } from "../src/client/ui/copy";

type Activity = Parameters<typeof ChannelActivityIndicators>[0];
const render = (activity: Activity) => renderToStaticMarkup(createElement(ChannelActivityIndicators, activity));
const glyph = (name: GlyphName) => renderToStaticMarkup(createElement(Glyph, { name, size: 14 }));
afterEach(() => setCopy({ lang: "en" }));

test("idle people have no activity badge or empty group", () => {
  expect(render({ sharing: false, sendingFiles: false, receivingFiles: false })).toBe("");
});

test.each([
  { sendingFiles: true, receivingFiles: false, label: "Sending files", icon: "fileUp" as const },
  { sendingFiles: false, receivingFiles: true, label: "Receiving files", icon: "fileDown" as const },
  { sendingFiles: true, receivingFiles: true, label: "Sending and receiving files", icon: "fileTransfer" as const },
])("file activity identifies $label with one direction-qualified document glyph", ({ label, icon, ...activity }) => {
  setCopy({ lang: "en" });
  const html = render(activity);
  expect(html).toContain(`role="img" aria-label="${label}"`);
  expect(html.match(/role="img"/g)).toHaveLength(1);
  expect(html).toContain(glyph(icon));
  expect(html).not.toMatch(/<button|role="button"|tabindex=/);
});

test.each([
  { microphone: true, deafened: false, label: "Joined voice; Microphone on", icon: "microphone" as const },
  { microphone: false, deafened: false, label: "Joined voice; Microphone off", icon: "microphoneOff" as const },
  { microphone: true, deafened: true, label: "Joined voice; Microphone on; Listening paused", icon: "headphonesOff" as const },
  { microphone: false, deafened: true, label: "Joined voice; Microphone off; Listening paused", icon: "headphonesOff" as const },
])("voice badge states $label without claiming speech or changing local listening", ({ microphone, deafened, label, icon }) => {
  setCopy({ lang: "en" });
  const html = render({ voice: { microphone, deafened } });
  expect(html).toContain(`role="img" aria-label="${label}"`);
  expect(html).toContain(glyph(icon));
  expect(html).not.toContain("Speaking");
  expect(html).not.toContain("--voice-level");
});

test("an offline person's row retains simultaneous activities and local playback while the picture connects", () => {
  setCopy({ lang: "en" });
  const person = {
    id: "friend", name: "A friend", self: false, owner: false, online: false,
    roomActivity: { voice: { microphone: false }, sharing: true, viewing: "preparing" as const, sendingFiles: true, receivingFiles: true },
    voicePlayback: { voicePlaybackByUser: new Map([["friend", { volume: 0.6, muted: true }]]), setVoiceVolume() {}, setVoiceMuted() {} },
  };
  const html = renderToStaticMarkup(createElement(ChannelUser, person));
  expect(html).toContain('class="c3-user is-offline"');
  expect(html.match(/role="img"/g)).toHaveLength(4);
  for (const label of ["Joined voice; Microphone off", "Sharing", "Watching; Connecting picture", "Sending and receiving files"])
    expect(html).toContain(`aria-label="${label}"`);
  expect(html).toContain('data-viewing="preparing"');
  expect(html).toContain(glyph("eye"));
  expect(html).toContain(renderToStaticMarkup(createElement(Glyph, { name: "loader", size: 10 })));
  expect(html).not.toContain("Picture received");
  expect(html).toContain('aria-pressed="false"');
  expect(html).toContain('aria-valuetext="60%"');
  expect(renderToStaticMarkup(createElement(ChannelUser, { ...person, self: true }))).not.toContain('type="range"');
});

test.each([
  ["zh", "正在发送文件", "正在接收文件", "正在发送和接收文件"],
  ["zh-Hant", "正在傳送檔案", "正在接收檔案", "正在傳送和接收檔案"],
  ["ja", "ファイルを送信中", "ファイルを受信中", "ファイルを送受信中"],
  ["ko", "파일 전송 중", "파일 수신 중", "파일 송수신 중"],
] as [Lang, string, string, string][])("file activity labels follow the %s locale", (lang, sending, receiving, both) => {
  setCopy({ lang });
  expect(render({ sendingFiles: true })).toContain(`aria-label="${sending}"`);
  expect(render({ receivingFiles: true })).toContain(`aria-label="${receiving}"`);
  expect(render({ sendingFiles: true, receivingFiles: true })).toContain(`aria-label="${both}"`);
});

test("compact couch keeps its pawn voice appearance without duplicating the voice badge", () => {
  setCopy({ lang: "en" });
  const html = renderToStaticMarkup(createElement(ChannelCouch, {
    people: [{ userId: "owned-person", name: "A friend", voice: { microphone: true, deafened: true },
      sharing: true, viewing: "active", sendingFiles: true, receivingFiles: true }],
    selfUserId: "owned-person", session: null,
  }));
  expect(html).toContain('class="lr-person-headset"');
  expect(html).toContain('data-voice="" data-deafened="true" data-microphone="true"');
  expect(html.match(/role="img"/g)).toHaveLength(3);
  expect(html).toContain('aria-label="Sharing"');
  expect(html).toContain('aria-label="Picture received"');
  expect(html).toContain('aria-label="Sending and receiving files"');
  expect(html).not.toContain('aria-label="Joined voice');
  expect(html).toContain('<span class="visually-hidden">Joined voice; Microphone on; Listening paused</span>');
});
