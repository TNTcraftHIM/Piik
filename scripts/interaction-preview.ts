import { createServer } from "vite";
import { createInteractionRooms } from "./interaction-room";
import { SIGNAL_PATH } from "../src/client/prototypes/interactions/protocol";

const port = 18961;
const rooms = createInteractionRooms();
const vite = await createServer({ server: { host: "127.0.0.1", port, strictPort: true } });
vite.httpServer!.on("upgrade", (request, socket, head) => {
  if (request.url !== SIGNAL_PATH) return;
  if (request.headers.origin !== `http://127.0.0.1:${port}` && request.headers.origin !== `http://localhost:${port}`) {
    socket.destroy(); return;
  }
  if (rooms.clients.size >= 64) { socket.destroy(); return; }
  rooms.handleUpgrade(request, socket, head, (client) => rooms.emit("connection", client, request));
});
await vite.listen();
console.log(`Interaction preview: http://127.0.0.1:${port}/__interaction-preview`);
let stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  for (const socket of rooms.clients) socket.terminate();
  rooms.close();
  await vite.close();
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
