import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { useChannelGuideSample } from "../src/client/pages/ChannelGuidePreview";
import { WatchSourceDialog } from "../src/client/channel/components/ChannelShareControl";

test("the guide sample owns the embedded-source methods used when opening the watch dialog", () => {
  function SampleDialog() {
    const { channel } = useChannelGuideSample();
    expect(channel.watchEmbed("friday")).toBeUndefined();
    expect(channel.prepareWatchEmbed).toBeTypeOf("function");
    expect(channel.confirmWatchEmbed).toBeTypeOf("function");
    return createElement(WatchSourceDialog, { channel, roomId: "friday", onClose() {} });
  }
  expect(() => renderToStaticMarkup(createElement(SampleDialog))).not.toThrow();
});
