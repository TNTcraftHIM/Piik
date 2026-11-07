import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import { ChannelConversation } from "../src/client/channel/components/ChannelConversation";
import type { ChannelAttachments } from "../src/client/channel/attachments";
import type { ChannelMessage } from "../src/client/channel/protocol";
import { downloadBlob } from "../src/client/lib/download";

const actions = vi.hoisted(() => [] as { icon: string; label: string; disabled?: boolean; onClick?: () => void }[]);
vi.mock("../src/client/channel/components/ChannelAction", () => ({ ChannelAction: (props: typeof actions[number]) => {
  actions.push(props);
  return createElement("button", { disabled: props.disabled }, props.label);
} }));
vi.mock("../src/client/ui/copy", () => ({ isCopyKey: () => false,
  useCopy: () => ({ lang: "en", vis: false, t: (key: string) => key }) }));
vi.mock("../src/client/lib/download", () => ({ downloadBlob: vi.fn() }));
vi.mock("../src/client/channel/components/ChannelAttachment", () => ({ ChannelAttachment: () => null }));

beforeEach(() => { actions.length = 0; vi.clearAllMocks(); });

const message = (seq: number, text: string): ChannelMessage => ({
  id: `private-message-${seq}`, userId: "private-user", seq, time: seq * 1000, text, attachments: [],
});
function render(messages: ChannelMessage[]) {
  renderToStaticMarkup(createElement(ChannelConversation, {
    roomId: "private-room", roomName: "Room", messages, users: [{ id: "private-user", name: "朋友\nFriend", roles: [] }],
    selfUserId: "private-user", canSend: false, sending: false, hidden: false, available: false,
    attachments: {} as ChannelAttachments, attachmentsAvailable: false,
    history: { hasMore: true, atLatest: false }, loadingHistory: false,
    onHistory: vi.fn(), onLatest: vi.fn(), onSend: vi.fn(), isReactionPending: () => false, onReaction: vi.fn(),
  }));
  return actions.find(action => action.icon === "save")!;
}

test("exports the loaded window as readable UTF-8 text without fetching history, files or identifiers", async () => {
  const action = render([message(7, "中文 👋\nSecond line"), { ...message(8, ""), attachments: [{
    id: "private-file", name: "secret.txt", size: 1, mediaType: "application/octet-stream", sha256: "a".repeat(64),
  }] }, { ...message(9, "Last"), userId: "departed-user", reactions: { revision: 1, choices: { someone: ["heart"] } } }]);
  expect(action.label).toBe("Export currently loaded text (TXT)");
  expect(action.disabled).toBe(false);
  action.onClick!();
  const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0];
  expect(blob.type).toBe("text/plain;charset=utf-8");
  expect(filename).toMatch(/^piik-chat-.*\.txt$/);
  expect(new Uint8Array(await blob.arrayBuffer()).slice(0, 3)).toEqual(new Uint8Array([239, 187, 191]));
  expect(await blob.text()).toBe("Piik chat\r\n\r\n[1970-01-01T00:00:07.000Z] 朋友\nFriend\r\n中文 👋\nSecond line\r\n\r\n[1970-01-01T00:00:09.000Z] User\r\nLast\r\n");
});

test.each([{ messages: [] }, { messages: [message(1, "")] }])("disables export when the loaded window has no text: $messages", ({ messages }) => {
  expect(render(messages).disabled).toBe(true);
  expect(downloadBlob).not.toHaveBeenCalled();
});
