import { afterEach, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelActivityIndicators, ChannelUser } from "../src/client/channel/components/ChannelUser";
import { ChannelCouch } from "../src/client/channel/components/ChannelCouch";
import { Glyph, type GlyphName } from "../src/client/ui/icons";
import { setCopy, type Lang } from "../src/client/ui/copy";

type Activity = Parameters<typeof ChannelActivityIndicators>[0];
const render = (activity: Activity) => renderToStaticMarkup(createElement(ChannelActivityIndicators, activity));
const glyph = (name: GlyphName, size = 14) => renderToStaticMarkup(createElement(Glyph, { name, size }));
afterEach(() => setCopy({ lang: "en" }));

function activityButtonGlyphs(html: string, label: string) {
  const tooltipIds = [...html.matchAll(/<[^>]+ role="tooltip"[^>]*>/g)]
    .map(([tooltip]) => tooltip.match(/ id="([^"]+)"/)?.[1]);
  const buttons = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)].filter(([, attributes]) => {
    const id = attributes.match(/ aria-controls="([^"]+)"/)?.[1];
    return id !== undefined && tooltipIds.includes(id);
  });
  expect(buttons).toHaveLength(1);
  const [, attributes, content] = buttons[0];
  expect(attributes.match(/ aria-label="([^"]+)"/)?.[1]).toBe(label);
  expect(attributes).toContain('aria-expanded="false"');
  expect(attributes).not.toMatch(/\bdisabled\b| tabindex="-/);
  return content.match(/<svg\b.*?<\/svg>/gs) ?? [];
}

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
  expect(activityButtonGlyphs(html, label)).toEqual([glyph(icon)]);
});

test.each([
  { microphone: true, deafened: false, label: "Joined voice; Microphone on", icon: "microphone" as const },
  { microphone: false, deafened: false, label: "Joined voice; Microphone off", icon: "microphoneOff" as const },
  { microphone: true, deafened: true, label: "Joined voice; Microphone on; Listening paused", icon: "headphonesOff" as const },
  { microphone: false, deafened: true, label: "Joined voice; Microphone off; Listening paused", icon: "headphonesOff" as const },
])("voice badge states $label without claiming speech or changing local listening", ({ microphone, deafened, label, icon }) => {
  setCopy({ lang: "en" });
  const html = render({ voice: { microphone, deafened } });
  expect(activityButtonGlyphs(html, label)).toEqual([glyph(icon)]);
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
  const label = "Joined voice; Microphone off; Sharing; Sending and receiving files; Connecting picture";
  expect(activityButtonGlyphs(html, label)).toEqual([
    glyph("microphoneOff"), glyph("cast"), glyph("fileTransfer"), glyph("eye"), glyph("loader", 10),
  ]);
  expect(html).toContain('data-viewing="preparing"');
  expect(html).not.toContain("Picture received");
  expect(html).not.toContain("Watching;");
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

test.each([
  { collaboration: false, sharing: true, sendingFiles: true, emblem: "cast", size: 14 },
  { collaboration: false, sharing: false, sendingFiles: true, emblem: "fileTransfer", size: 14 },
  { collaboration: false, sharing: false, sendingFiles: false, emblem: "loader", size: 14 },
  { collaboration: true, sharing: true, sendingFiles: true, emblem: "mouse", size: 15 },
] as const)("compact couch wears $emblem while describing every activity from one control", ({
  collaboration, sharing, sendingFiles, emblem, size,
}) => {
  setCopy({ lang: "en" });
  const html = renderToStaticMarkup(createElement(ChannelCouch, {
    people: [{ userId: "owned-person", name: "A friend", voice: { microphone: true, deafened: true, level: 0.5 },
      collaboration, sharing, viewing: "preparing", sendingFiles, receivingFiles: sendingFiles }],
    selfUserId: "owned-person", session: null, compact: true,
  }));
  expect(html).toContain('class="lr-person-headset"');
  expect(html).toContain('data-voice="" data-deafened="true" data-microphone="true"');
  expect(html.match(/<button\b/g)).toHaveLength(1);
  expect(html).toContain('aria-label="A friend"');
  expect(html).toContain("--voice-level:");
  const description = ["Joined voice", "Microphone on", "Listening paused",
    ...(sharing ? ["Sharing"] : []), ...(sendingFiles ? ["Sending and receiving files"] : []), "Connecting picture"];
  expect(html).toContain(`aria-description="${description.join("; ")}"`);
  expect(html).not.toContain("c3-couch-activity");
  expect(html).toContain('data-emblem=""');
  expect(html.match(/class="lr-person-emblem".*?(<svg\b.*?<\/svg>)/s)?.[1]).toBe(glyph(emblem, size));
});
