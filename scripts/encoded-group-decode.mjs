import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

const customInput = process.env.SCREENER_ENCODED_OUTPUT;
const codec = process.env.SCREENER_ENCODED_CODEC ?? "vp8";
assert.ok(["vp8", "avc1.42c033"].includes(codec), "Expected VP8 or constrained-baseline H264");
const inputPath = customInput ? resolve(customInput) : new URL("../build/embedded-media/encoded-group.received.json", import.meta.url);
const input = await readFile(inputPath);
const streams = JSON.parse(input);
assert.equal(streams.length, 2);
for (const frames of streams) {
  if (customInput) assert.ok(frames.length > 0 && frames.length <= 1200);
  else assert.equal(frames.length, 40);
}
const expectedCounts = streams.map((frames) => frames.length);
const page = `<!doctype html><meta charset="utf-8"><title>Shared encoded output decode</title>
<pre id="result">Decoding encoded input...</pre><script>
(async () => {
  const streams = await (await fetch('/frames')).json();
  const results = [];
  for (const rows of streams) {
    let accept, reject;
    const decoded = [];
    const decoder = new VideoDecoder({output: frame => accept(frame), error: error => reject(error)});
    try {
      decoder.configure({codec:${JSON.stringify(codec)}, hardwareAcceleration:'prefer-software', optimizeForLatency:true});
      for (const row of rows) {
        const pending = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
        decoder.decode(new EncodedVideoChunk({type:row.Recovery ? 'key' : 'delta',
          timestamp:Math.round(row.PTS/1000), data:Uint8Array.from(atob(row.Data), c=>c.charCodeAt(0))}));
        const frame = await pending;
        try {
          if (frame.displayWidth !== row.Width || frame.displayHeight !== row.Height || frame.timestamp !== Math.round(row.PTS/1000))
            throw Error('Decoded frame differs from selected output');
          decoded.push([row.Index, frame.displayWidth, frame.displayHeight, frame.timestamp]);
        } finally { frame.close(); }
      }
      results.push(decoded);
    } finally { if (decoder.state !== 'closed') decoder.close(); }
  }
  window.decodeResult = {passed:true, userAgent:navigator.userAgent, results};
})().catch(error => { window.decodeResult = {passed:false,error:String(error)}; }).finally(async()=>{
  document.querySelector('#result').textContent = JSON.stringify(window.decodeResult);
  await fetch('/result', {method:'POST',body:JSON.stringify(window.decodeResult)});
});
</script>`;
const server = createServer(async (request, response) => {
  if (request.url === "/frames") {
    response.writeHead(200, { "Content-Type": "application/json" }).end(input);
  } else if (request.url === "/result" && request.method === "POST") {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const result = JSON.parse(Buffer.concat(body).toString());
    assert.equal(result.passed, true, result.error);
    assert.deepEqual(result.results.map((frames) => frames.length), expectedCounts);
    result.receivedSha256 = createHash("sha256").update(input).digest("hex");
    result.codec = codec;
    result.scope = "Encoded input -> two Chrome WebCodecs decoders; input provenance is owned by its producing fixture, not proof of Browser WebRTC transport, jitter-buffer or hardware acceptance";
    result.sources = {};
    for (const path of ["go.mod", "go.sum", "internal/media/encoded/packetizer.go",
      "internal/media/forwarding/source.go", "internal/media/forwarding/encoded_source.go",
      "internal/media/forwarding/output.go", "internal/media/forwarding/transport.go",
      "internal/client/mediaedge/engine.go", "internal/client/mediaedge/source.go",
      "internal/client/mediaedge/edge.go", "internal/client/mediaedge/group_fixture_test.go",
      "internal/client/mediaedge/relay_network_fixture_test.go", "internal/client/mediaedge/relay_derivation.go",
      "native/capture/windows/encoded_group.fixture.cpp"]) {
      result.sources[path] = createHash("sha256").update(await readFile(new URL(`../${path}`, import.meta.url))).digest("hex");
    }
    const resultPath = customInput ? `${inputPath}.decode-result.json` : new URL("../build/embedded-media/encoded-group.decode-result.json", import.meta.url);
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    response.end("passed");
    console.log(`Passed: receivers decoded ${expectedCounts.join(" and ")} received frames`);
    clearTimeout(deadline);
    server.close();
  } else {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
  }
});
const deadline = setTimeout(() => { process.exitCode = 1; server.closeAllConnections(); server.close(); }, 60000);
server.listen(0, "127.0.0.1", () => console.log(`http://127.0.0.1:${server.address().port}`));
