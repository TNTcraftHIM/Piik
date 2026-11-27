import { afterEach, expect, test, vi } from "vitest";
import { NativeDomainHosting } from "../src/client/channel/hosting-api";

const hosting = new NativeDomainHosting({});
afterEach(() => vi.unstubAllGlobals());

test.each([
  ["explicit rejection", Response.json({ error: "forbidden" }, { status: 403 }), "forbidden"],
  ["service rejected before handoff", Response.json({ error: "domain_restore_unavailable" }, { status: 409 }), "domain_restore_unavailable"],
  ["scratch storage unavailable", Response.json({ error: "restore_scratch_limit" }, { status: 507 }), "restore_scratch_limit"],
  ["committed with hosting failure", Response.json({ error: "domain_restored_connection_failed" }, { status: 409 }), "domain_restored_connection_failed"],
  ["service lost the result", Response.json({ error: "domain_restore_unavailable" }, { status: 503 }), "domain_restore_unconfirmed"],
  ["upstream failure", new Response("bad gateway", { status: 502 }), "domain_restore_unconfirmed"],
  ["truncated success", new Response('{"domainId":'), "domain_restore_unconfirmed"],
  ["success without the site ID", Response.json({}), "domain_restore_unconfirmed"],
] as const)("classifies a site restore reply indicating %s", async (_outcome, reply, expected) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply));
  await expect(hosting.restore(new Blob())).rejects.toThrow(expected);
});
