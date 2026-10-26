import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import WebSocket from "ws";

async function connect() {
  const socket = new WebSocket("ws://127.0.0.1:8791/channels", {
    origin: "http://127.0.0.1:8790",
  });
  const inbox = [];
  let waiting;
  socket.on("message", (bytes) => {
    const event = JSON.parse(bytes.toString());
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(event);
    } else inbox.push(event);
  });
  await once(socket, "open");
  return {
    socket,
    next: () =>
      inbox.length
        ? Promise.resolve(inbox.shift())
        : new Promise((resolve) => {
            waiting = resolve;
          }),
  };
}

test(
  "two clients exchange channel messages, retain history and reject spoofed identity",
  { timeout: 8000 },
  async (t) => {
    const first = await connect();
    const second = await connect();
    t.after(() => {
      first.socket.close();
      second.socket.close();
    });
    const a = await first.next();
    const b = await second.next();
    assert.equal(a.type, "welcome");
    assert.notEqual(a.identity, b.identity);
    const text = `prototype-check-${Date.now()}`;
    first.socket.send(JSON.stringify({ channel: "studio", text }));
    const sent = await first.next();
    const received = await second.next();
    assert.deepEqual(sent, received);
    assert.equal(received.channel, "studio");
    assert.equal(received.message.sender, a.identity);
    assert.equal(received.message.text, text);
    const returning = await connect();
    t.after(() => returning.socket.close());
    const snapshot = await returning.next();
    assert(snapshot.history.studio.some((message) => message.text === text));
    assert(!snapshot.history.living.some((message) => message.text === text));
    const closed = once(first.socket, "close");
    first.socket.send(
      JSON.stringify({ channel: "studio", text: "forged", sender: b.identity }),
    );
    await closed;
  },
);
