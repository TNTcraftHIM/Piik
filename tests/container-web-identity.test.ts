import { describe, expect, it, vi } from "vitest";
import { checkWebSourceIdentity } from "../scripts/container-web-identity.mjs";

const revision = "a".repeat(40);
const main = "/assets/index-current.js";
const shared = "/assets/session-current.js";
const html = `<script type="module" crossorigin src="${main}"></script>
<link rel="modulepreload" crossorigin href="${shared}">`;

describe("container Web source identity", () => {
  it.each([main, shared])("checks the served revision in %s", async identityAsset => {
    const read = vi.fn(async (asset: string) => asset === identityAsset ? `const revision="${revision}"` : "export{};");
    await checkWebSourceIdentity(html, revision, read);
    expect(read.mock.calls.map(([asset]) => asset)).toEqual([main, shared]);
  });

  it("rejects a different revision even when an unrelated asset has the expected one", async () => {
    const assets = new Map([[main, "export{};"], [shared, `const revision="${"b".repeat(40)}"`],
      ["/assets/orphan.js", `const revision="${revision}"`]]);
    await expect(checkWebSourceIdentity(html, revision, async (asset: string) => assets.get(asset)!))
      .rejects.toThrow("Web and Server must have the same source identity");
  });

  it("rejects a missing declared module even when the entry has the right revision", async () => {
    await expect(checkWebSourceIdentity(html, revision, async (asset: string) => {
      if (asset === shared) throw new Error("HTTP 404");
      return revision;
    })).rejects.toThrow("HTTP 404");
  });

  it("requires the served Web entry", async () => {
    const read = vi.fn();
    await expect(checkWebSourceIdentity(`<link rel="modulepreload" href="${shared}">`, revision, read))
      .rejects.toThrow("Server must embed the Web UI");
    expect(read).not.toHaveBeenCalled();
  });
});
