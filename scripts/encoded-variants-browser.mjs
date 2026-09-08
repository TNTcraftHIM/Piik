import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const output = new URL("../build/embedded-media/browser-variants-result.json", import.meta.url);
const worker = await readFile(new URL("./encoded-variants-worker.js", import.meta.url));
const page = `<!doctype html><meta charset="utf-8"><title>Encoded variants probe</title>
<button id="run">Run bounded software-codec comparison</button><pre id="status">Ready</pre>
<script>
let running = false;
document.querySelector('#run').onclick = () => {
  if (running) return;
  running = true;
  const worker = new Worker('/worker.js');
  const timeout = setTimeout(() => { worker.terminate(); window.probeError = 'deadline'; }, 240000);
  worker.onmessage = async ({data}) => {
    document.querySelector('#status').textContent = JSON.stringify(data);
    if (data.progress) return;
    clearTimeout(timeout);
    worker.terminate();
    if (data.error) { window.probeError = data.error; return; }
    window.probeResult = data;
    await fetch('/result', {method:'POST', body:JSON.stringify(data)});
  };
  worker.onerror = ({message}) => { clearTimeout(timeout); worker.terminate(); window.probeError = message; };
  worker.postMessage('run');
};
</script>`;
const server = createServer(async (request, response) => {
  if (request.url === "/worker.js") {
    response.writeHead(200, { "Content-Type": "text/javascript" }).end(worker);
  } else if (request.url === "/result" && request.method === "POST") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const result = JSON.parse(Buffer.concat(chunks).toString());
    result.workerSha256 = createHash("sha256").update(worker).digest("hex");
    await mkdir(new URL("./", output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Saved ${result.results.length} runs to ${fileURLToPath(output)}`);
    response.end("saved");
  } else {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
  }
});
server.listen(0, "127.0.0.1", () => console.log(`http://127.0.0.1:${server.address().port}`));
process.on("SIGINT", () => server.close());
