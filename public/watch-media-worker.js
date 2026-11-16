// Only media fetches use this worker. Business state and resources stay in the requesting page.
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/__watch-media/")) return;
  event.respondWith(serve(event, url));
});

async function serve(event, url) {
  if (!["GET", "HEAD"].includes(event.request.method) || !["", "video", "audio", "track"].includes(event.request.destination) || !event.clientId) return new Response(null, { status: 403 });
  const parts = url.pathname.slice("/__watch-media/".length).split("/");
  const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
  if (parts.length !== 2 || !parts.every(part => uuid.test(part))) return new Response(null, { status: 404 });
  const client = await self.clients.get(event.clientId);
  if (!client || new URL(client.url).origin !== self.location.origin) return new Response(null, { status: 403 });
  if (event.request.signal.aborted) return new Response(null, { status: 410 });
  const { port1: port, port2 } = new MessageChannel();
  const pending = new Map();
  let sequence = 0, closed = false;
  const close = () => {
    if (closed) return;
    closed = true; port.postMessage({ type: "cancel" }); port.close();
    for (const current of pending.values()) current.reject(new Error("watch_media_failed"));
    pending.clear();
    event.request.signal.removeEventListener("abort", close);
  };
  const rpc = data => new Promise((resolve, reject) => {
    if (closed) { reject(new Error("watch_media_failed")); return; }
    const id = ++sequence;
    // The page's reader owns route readiness and response timing. Fetch/port cancellation owns this wait.
    pending.set(id, { resolve, reject });
    port.postMessage({ ...data, id });
  });
  port.onmessage = ({ data }) => {
    if (data.error) { close(); return; }
    const current = pending.get(data.id);
    if (!current) return;
    pending.delete(data.id);
    current.resolve(data);
  };
  event.request.signal.addEventListener("abort", close, { once: true });
  client.postMessage({ type: "watch_resource_open", leaseId: parts[0], resourceId: parts[1] }, [port2]);
  try {
    const { size, mimeType } = await rpc({ type: "stat" });
    if (!Number.isSafeInteger(size) || size < 0 || typeof mimeType !== "string") throw new Error("watch_media_failed");
    let start = 0, end = size - 1;
    const range = event.request.method === "GET" ? event.request.headers.get("range") : null;
    const headers = { "Content-Type": mimeType, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) { close(); return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } }); }
      if (match[1]) { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
      else { const suffix = Number(match[2]); start = suffix > 0 ? Math.max(0, size - suffix) : size; }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) { close(); return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } }); }
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    }
    headers["Content-Length"] = String(end - start + 1);
    if (event.request.method === "HEAD" || size === 0) { close(); return new Response(null, { status: 200, headers }); }
    let position = start;
    const windows = [];
    const fill = () => {
      while (!closed && windows.length < 4 && position <= end) {
        const length = Math.min(65536, end - position + 1);
        const reading = rpc({ type: "read", offset: position, length }).then(({ bytes }) => {
          if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== length) throw new Error("watch_media_failed");
          return new Uint8Array(bytes);
        });
        // A later window may fail before the consumer reaches it.
        void reading.catch(() => {});
        windows.push(reading); position += length;
      }
    };
    const body = new ReadableStream({
      async pull(controller) {
        try {
          fill();
          const bytes = await windows[0]; windows.shift();
          controller.enqueue(bytes);
          if (!windows.length && position > end) { controller.close(); close(); }
        } catch (error) { controller.error(error); close(); }
      },
      cancel() { close(); },
    }, { highWaterMark: 0 });
    return new Response(body, { status: range ? 206 : 200, headers });
  } catch { close(); return new Response(null, { status: 410 }); }
}
