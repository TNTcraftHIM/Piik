import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChannelAttachment } from "../src/client/channel/components/ChannelAttachment";
import type { ChannelAttachments } from "../src/client/channel/attachments";
import { t } from "../src/client/ui/copy";

function renderCard(availability: boolean | undefined, busy = false, error: string | null = null) {
  const client = {
    subscribe: () => () => {},
    status: () => ({ busy, error }),
    progress: () => undefined,
    hasSavedCopy: () => false,
    originalAvailability: () => availability,
  };
  return renderToStaticMarkup(createElement(ChannelAttachment, {
    client: client as unknown as ChannelAttachments,
    roomId: "room",
    messageSeq: 10,
    file: { id: "image", name: "room.png", mediaType: "image/png", size: 1024, sha256: "0".repeat(64) },
  }));
}

describe("attachment original availability", () => {
  it("disables both original actions when a visible file has no holder", () => {
    const markup = renderCard(false);
    expect(markup.match(/<button\b[^>]* disabled=""/g)).toHaveLength(2);
    expect(markup).toContain(t("zh", "channel.attachment.noOriginalSource"));
  });

  it.each([undefined, true])("leaves both actions available when availability is %s", availability => {
    const markup = renderCard(availability);
    expect(markup).not.toContain('disabled=""');
    expect(markup).not.toContain(t("zh", "channel.attachment.noOriginalSource"));
  });

  it("keeps cancellation available after the last holder leaves an active transfer", () => {
    const markup = renderCard(false, true);
    expect(markup.match(/<button\b[^>]* disabled=""/g)).toHaveLength(1);
    expect(markup).toContain(t("zh", "channel.attachment.cancelDownload"));
    expect(markup).not.toContain(t("zh", "channel.attachment.noOriginalSource"));
  });

  it("keeps a failed native save visible when the last holder leaves", () => {
    const markup = renderCard(false, false, "download_failed");
    expect(markup).toContain(t("zh", "channel.attachment.saveFailed"));
    expect(markup).toContain(t("zh", "channel.attachment.noOriginalSource"));
  });

  it("keeps a failed transfer visible when the last holder leaves", () => {
    const markup = renderCard(false, false, "file_storage_full");
    expect(markup).toContain(t("zh", "channel.attachment.storageFull"));
    expect(markup).toContain(t("zh", "channel.attachment.noOriginalSource"));
  });

  it("reports an expired saved file after the user opens its folder", () => {
    const markup = renderCard(false, false, "saved_copy_missing");
    expect(markup).toContain(`${t("zh", "channel.attachment.savedCopyMissing")} ${t("zh", "channel.attachment.noOriginalSource")}`);
    const availableMarkup = renderCard(true, false, "saved_copy_missing");
    expect(availableMarkup).toContain(t("zh", "channel.attachment.savedCopyMissing"));
    expect(availableMarkup).not.toContain('disabled=""');
  });
});
