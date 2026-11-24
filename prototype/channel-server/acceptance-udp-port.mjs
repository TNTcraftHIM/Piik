import { createSocket } from "node:dgram";
import { once } from "node:events";

// TCP and UDP have separate port availability.
export async function freeUdpPort() {
  const socket = createSocket("udp4");
  const listening = once(socket, "listening");
  socket.bind(0, "127.0.0.1");
  await listening;
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
