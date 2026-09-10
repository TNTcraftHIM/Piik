import { afterEach, describe, expect, it } from "vitest";

import { setCopy, t, type Copy, type CopyKey } from "../src/client/ui/copy.ts";
import {
  resolveMediaFailure,
  type MediaFailure,
} from "../src/client/ui/media-failure.ts";

// Only the language and the resolver are read; a switch re-renders callers.
const copy = (lang: "zh" | "en"): Pick<Copy, "lang" | "t"> => ({
  lang,
  t: (key: CopyKey, vars?: Record<string, string>) => t(lang, key, vars),
});

describe("resolveMediaFailure", () => {
  afterEach(() => {
    setCopy({ lang: "zh", vis: false });
  });

  it("renders a fact in the copy context language, not the stored locale", () => {
    setCopy({ lang: "zh" });
    const failure: MediaFailure = { key: "host.fail.connection" };

    expect(resolveMediaFailure(failure, copy("zh"))).toBe(
      t("zh", "host.fail.connection"),
    );
    expect(resolveMediaFailure(failure, copy("en"))).toBe(
      t("en", "host.fail.connection"),
    );
  });

  it("fills the params slot from copy keys", () => {
    const failure: MediaFailure = {
      key: "host.warn.senderPartial",
      paramKeys: ["host.warn.param.maxBitrate", "host.warn.param.maxFramerate"],
    };

    const text = resolveMediaFailure(failure, copy("en"));

    expect(text).toContain(t("en", "host.warn.param.maxBitrate"));
    expect(text).toContain(t("en", "host.warn.param.maxFramerate"));
    expect(text).not.toContain("{params}");
  });

  it("renders every failure in a list and nothing for none", () => {
    const text = resolveMediaFailure(
      [{ key: "host.fail.sfuSwitch" }, { key: "host.fail.sfuParams" }],
      copy("en"),
    );

    expect(text).toContain(t("en", "host.fail.sfuSwitch"));
    expect(text).toContain(t("en", "host.fail.sfuParams"));
    expect(resolveMediaFailure(null, copy("en"))).toBeNull();
    expect(resolveMediaFailure([], copy("en"))).toBeNull();
  });

  it("interpolates literal variables", () => {
    expect(
      resolveMediaFailure(
        { key: "host.warn.audioRewritten", vars: { kbps: "96" } },
        copy("en"),
      ),
    ).toBe(t("en", "host.warn.audioRewritten", { kbps: "96" }));
  });
});
