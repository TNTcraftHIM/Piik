import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { PlaybackSettings, type PlaybackSettingsProps } from "../src/client/components/living/PlaybackSettings";

import {
  relayCapacityMessageForBrowser,
  relayVolunteerLimit,
} from "../src/client/media/relay-capability.ts";

describe("browser relay capability", () => {
  it("advertises the endpoint capability envelope without a Browser tier", () => {
    expect(relayCapacityMessageForBrowser()).toEqual({
      type: "relay-capacity",
      downstreamEdges: 3,
    });
  });

});

// Execute the page's actual request owner and React props together. Backend
// changes must adjust the applied limit without replacing the user's choice.
const source = ts.createSourceFile("ViewerPage.tsx", readFileSync(
  new URL("../src/client/pages/ViewerPage.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let update = "", props = "";
const authentication: string[] = [];
function collect(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "updateRelayVolunteer") update = node.getText(source);
  if (ts.isPropertyAssignment(node) && node.name.getText(source) === "relayVolunteer" && ts.isConditionalExpression(node.initializer)) {
    props = node.initializer.getText(source);
  }
  if (ts.isIfStatement(node) && node.expression.getText(source) === 'message.type === "authenticated"' && ts.isBlock(node.thenStatement)) {
    for (const statement of node.thenStatement.statements) {
      const text = statement.getText(source);
      if (text.startsWith("ordinaryRelayCapacity =") || text.startsWith("signal.send(relayCapacityMessageForBrowser())") || text.startsWith("updateRelayVolunteer(")) authentication.push(text);
    }
  }
  ts.forEachChild(node, collect);
}
collect(source);
if (!update || !props || authentication.length !== 3) throw new Error("Viewer relay capacity owner was not found");
const executable = ts.transpile(`${update}\n globalThis.update = updateRelayVolunteer; globalThis.props = () => (${props});
 globalThis.reauthenticate = () => { ${authentication.join("\n")} };`,
  { target: ts.ScriptTarget.ES2022 });

it("keeps the requested limit through backend changes while React displays the effective value", () => {
  const wire: Array<{ enabled: boolean; capacity: number }> = [];
  const order: string[] = [];
  const signal = {
    relayVolunteerRequest: null as { enabled: boolean; capacity: number } | null,
    send: () => { order.push("ordinary"); return true; },
    setRelayVolunteer(enabled: boolean, capacity: number) {
      this.relayVolunteerRequest = { enabled, capacity };
      wire.push({ enabled, capacity });
      order.push("volunteer");
      return true;
    },
  };
  const context = createContext({
    signal, relayVolunteerLimit, relayCapacityMessageForBrowser, message: { endpointMediaCopyCapacity: 2 },
    relayBackendCapacity: 20, ordinaryRelayCapacity: 2, requestedRelayCapacity: null,
    clientActivationRef: { current: false }, MAX_ENDPOINT_MEDIA_CHILDREN: 3, MAX_VIEWERS_PER_ROOM_LIMIT: 20,
    relayVolunteerAvailable: true, relayVolunteerSupported: true, relayVolunteerEnabled: false,
    relayVolunteerPending: false, signalStatus: "connected", relayVolunteerLimits: relayVolunteerLimit(null, 2, 20),
    requestRelayVolunteerRef: { current: null as ((enabled: boolean, capacity?: number) => void) | null },
    setRelayVolunteerLimits: (limits: ReturnType<typeof relayVolunteerLimit>) => { context.relayVolunteerLimits = limits; },
    setRelayVolunteerPending: vi.fn(),
  });
  runInContext(executable, context);
  const request = context.update as (enabled?: boolean, capacity?: number, send?: boolean) => void;
  context.requestRelayVolunteerRef.current = request;
  const settings = () => (context.props as () => NonNullable<PlaybackSettingsProps["relayVolunteer"]>)();
  const render = () => renderToStaticMarkup(createElement(PlaybackSettings, { relayVolunteer: settings(), reconnect: null }));
  expect(render()).not.toContain('name="relay-capacity"');
  settings().onChange(true);
  expect(wire.at(-1)).toEqual({ enabled: true, capacity: 3 });
  context.relayVolunteerEnabled = true;
  const number = render().match(/<input[^>]*name="relay-capacity"[^>]*>/)?.[0];
  for (const attribute of ['min="3"', 'max="20"', 'value="3"']) expect(number).toContain(attribute);
  settings().onCapacityChange(8);
  expect(wire.at(-1)).toEqual({ enabled: true, capacity: 8 });
  context.relayBackendCapacity = 3;
  request();
  expect(settings().capacity).toBe(3);
  expect(wire.at(-1)).toEqual({ enabled: true, capacity: 3 });
  context.relayBackendCapacity = 20;
  request();
  expect(settings().capacity).toBe(8);
  expect(wire.at(-1)).toEqual({ enabled: true, capacity: 8 });
  const count = wire.length;
  request(undefined, undefined, false);
  expect(wire).toHaveLength(count);
  context.ordinaryRelayCapacity = context.relayBackendCapacity = 3;
  request();
  expect(settings().available).toBe(false);
  expect(render()).toContain('name="relay-capacity"');
  settings().onChange(false);
  expect(wire.at(-1)).toEqual({ enabled: false, capacity: 3 });
  context.relayVolunteerEnabled = false;
  expect(settings().disabled).toBe(true);
  expect(render()).not.toContain('name="relay-capacity"');
  context.ordinaryRelayCapacity = 2;
  context.relayBackendCapacity = 20;
  request();
  expect(wire.at(-1)).toEqual({ enabled: false, capacity: 20 });
  settings().onChange(true);
  expect(wire.at(-1)).toEqual({ enabled: true, capacity: 8 });
  settings().onCapacityChange(3);
  const before = order.length;
  context.message.endpointMediaCopyCapacity = 3;
  (context.reauthenticate as () => void)();
  expect(settings().capacity).toBe(4);
  expect(wire.at(-1)).toEqual({ enabled: true, capacity: 4 });
  expect(order.slice(before)).toEqual(["ordinary", "volunteer"]);
  context.message.endpointMediaCopyCapacity = 2;
  (context.reauthenticate as () => void)();
  expect(settings().capacity).toBe(3);
  expect(wire.at(-1)).toEqual({ enabled: true, capacity: 3 });
});
