import { openTransferStorage, type TransferStorage } from "../../../src/client/channel/transfer-storage";

async function writeTransfer(storage: TransferStorage): Promise<File> {
  const handle = await storage.directory.getFileHandle("attachment", { create: true });
  const writer = await handle.createWritable();
  await writer.write("readable");
  await writer.close();
  return handle.getFile();
}

export async function createTransferProbe() {
  const storage = await openTransferStorage();
  return { storage, file: await writeTransfer(storage) };
}

export async function checkTransferStorage(): Promise<void> {
  type Probe = Awaited<ReturnType<typeof createTransferProbe>>;
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const peerWindow = frame.contentWindow!;
  let active: TransferStorage | undefined;
  let next: TransferStorage | undefined;
  try {
    const peer = await new Promise<Probe>((resolve, reject) => {
      Object.assign(peerWindow, { resolveProbe: resolve, rejectProbe: reject });
      const script = peerWindow.document.createElement("script");
      script.type = "module";
      script.textContent = `try {
        const { createTransferProbe } = await import(${JSON.stringify(import.meta.url)});
        window.resolveProbe(await createTransferProbe());
      } catch (error) { window.rejectProbe(error); }`;
      peerWindow.document.head.append(script);
    });
    active = await openTransferStorage();
    const file = await writeTransfer(active);
    if (await peer.file.slice(4).text() !== "able") throw new Error("Another tab removed an active transfer");
    frame.remove();
    const name = `piik-channel-transfer-sessions/${peer.storage.directory.name}`;
    await navigator.locks.request(name, () => {});
    next = await openTransferStorage();
    const root = await navigator.storage.getDirectory();
    const sessions = await root.getDirectoryHandle("piik-channel-transfer-sessions");
    const exists = async (name: string) => {
      for await (const entry of sessions.keys()) if (entry === name) return true;
      return false;
    };
    if (await exists(peer.storage.directory.name)) throw new Error("Abandoned transfer survived reopening");
    if (await file.text() !== "readable") throw new Error("Reclaiming an abandoned transfer removed an active file");
    await active.close();
    if (await exists(active.directory.name)) throw new Error("Closing transfer storage left its directory behind");
  } finally {
    frame.remove();
    await Promise.all([active?.close(), next?.close()]);
  }
}
