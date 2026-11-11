// One manually supplied, temporary App room. Uses its normal Web/WASM unchanged.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function readContract(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("invalid_lab_json"); }
  const fields = ["inviteURL", "roomId", "hostSessionId", "sourceSessionId", "publicationId", "apkSha256", "appRevision"];
  assert(value && typeof value === "object" && !Array.isArray(value), "invalid_lab_contract");
  assert(Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)), "invalid_lab_fields");
  for (const field of fields) assert(typeof value[field] === "string" && value[field], `invalid_lab_${field.toLowerCase()}`);
  let url;
  try { url = new URL(value.inviteURL); } catch { throw new Error("invalid_lab_url"); }
  const fragment = new URLSearchParams(url.hash.slice(1));
  assert(url.protocol === "https:" && /^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname)
    && !url.username && !url.password && !url.port && !url.search
    && ["/", "/__channel-preview"].includes(url.pathname), "invalid_lab_origin");
  assert([...fragment.keys()].every(key => ["invite", "room"].includes(key)), "invalid_room_link_fields");
  assert(fragment.get("room") === value.roomId, "invitation_room_mismatch");
  for (const field of ["roomId", "hostSessionId", "sourceSessionId", "publicationId"])
    assert(/^[A-Za-z0-9_-]{1,128}$/.test(value[field]), `invalid_lab_${field.toLowerCase()}`);
  assert(/^[a-f0-9]{64}$/i.test(value.apkSha256), "invalid_lab_apksha256");
  assert(/^[a-f0-9]{40}$/i.test(value.appRevision), "invalid_lab_apprevision");
  return value;
}

export function independentEgress(selected) {
  const publicAddress = value => {
    if (typeof value !== "string") return false;
    if (isIP(value) === 6) return /^[23]/i.test(value) && !/^2001:db8:/i.test(value);
    if (isIP(value) !== 4) return false;
    const [a, b, c] = value.split(".").map(Number);
    return a > 0 && a < 224 && a !== 10 && a !== 127 && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168)
      && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && [18, 19].includes(b))
      && !(a === 192 && b === 0) && !(a === 198 && b === 51 && c === 100) && !(a === 203 && b === 0 && c === 113);
  };
  if (!selected || selected.protocol !== "udp") return false;
  const mapped = typeof selected.localAddress === "string" && Number.isInteger(selected.localPort) && selected.localPort > 0
    ? selected.localCandidates?.find(candidate => candidate.type === "srflx" && candidate.protocol === "udp"
      && candidate.relatedAddress === selected.localAddress && candidate.relatedPort === selected.localPort) : undefined;
  const local = publicAddress(selected.localAddress) ? selected.localAddress : mapped?.address;
  return publicAddress(local) && publicAddress(selected.remoteAddress) && local !== selected.remoteAddress;
}

// Same production Session lookup used by the normal-APK ICE observer. No mock,
// DEV entry, capture replacement, protocol interception or transport mutation.
function installObserver() {
  localStorage.setItem("piik:ui-lang", "en");
  localStorage.setItem("piik:ui-mode", "text");
  const seen = [];
  let session;
  const find = () => {
    if (session) return session;
    const node = document.querySelector(".c3-room-navigation button");
    let fiber = node?.[Object.keys(node).find(key => key.startsWith("__reactFiber$"))];
    for (; fiber; fiber = fiber.return) for (let hook = fiber.memoizedState; hook; hook = hook.next) {
      if (hook.memoizedState?.getSnapshot && hook.memoizedState?.media?.peers) return session = hook.memoizedState;
    }
  };
  const selected = async pc => {
    const reports = await pc.getStats();
    const transport = [...reports.values()].find(report => report.type === "transport" && report.selectedCandidatePairId);
    const pair = reports.get(transport?.selectedCandidatePairId);
    if (!pair) return null;
    const local = reports.get(pair.localCandidateId), remote = reports.get(pair.remoteCandidateId);
    const localCandidates = (pc.localDescription?.sdp ?? "").split(/\r?\n/).flatMap(line => {
      if (!line.startsWith("a=candidate:")) return [];
      try {
        const candidate = new RTCIceCandidate({ candidate: line.slice(2) });
        return candidate.type === "srflx" ? [{ type: candidate.type, protocol: candidate.protocol, address: candidate.address,
          relatedAddress: candidate.relatedAddress, relatedPort: candidate.relatedPort }] : [];
      } catch { return []; }
    });
    return { protocol: local?.protocol, localType: local?.candidateType, remoteType: remote?.candidateType,
      localAddress: local?.address ?? local?.ip, localPort: local?.port, localCandidates,
      remoteAddress: remote?.address ?? remote?.ip,
      requests: pair.requestsSent, responses: pair.responsesReceived, bytesSent: pair.bytesSent, bytesReceived: pair.bytesReceived,
      channels: [...reports.values()].filter(report => report.type === "data-channel")
        .map(report => ({ state: report.state, sent: report.messagesSent, received: report.messagesReceived })) };
  };
  window.__publicPeer = {
    async sample(config, nonce) {
      const current = find();
      if (!current) return { attached: false };
      const value = current.getSnapshot(), room = value.state?.channel.rooms.find(room => room.id === config.roomId);
      for (const peer of current.media.peers.values()) {
        if (!seen.some(entry => entry.pc === peer.transport.pc)) seen.push({ pc: peer.transport.pc, peerId: peer.plan.peerId });
      }
      // The existing observer samples live peers; Native logs own the full attempt timeline.
      const first = seen.find(entry => entry.peerId === config.hostSessionId);
      const active = [...current.media.peers.values()].find(peer => peer.plan.peerId === config.hostSessionId && peer.plan.rooms.includes(config.roomId));
      const messages = value.messagesByRoom[config.roomId] ?? [];
      const confirmation = messages.find(message => message.text === nonce && message.userId === value.self?.id);
      const publication = value.state?.publications.find(publication => publication.id === config.publicationId);
      const input = value.screenInputs.get(config.publicationId)?.find(input => input.selected);
      const flowPair = value.state?.pairs.find(pair => pair.incoming.some(flow => flow.id === input?.flowId && flow.selected));
      const mediaPeer = flowPair && current.media.peers.get(flowPair.id);
      const track = input?.stream.getVideoTracks()[0];
      const video = [...document.querySelectorAll('video[data-selected="true"]')].find(video => video.srcObject === input?.stream);
      const receiver = mediaPeer?.transport.pc.getReceivers().find(receiver => receiver.track === track);
      const reports = receiver && await receiver.getStats();
      const inbound = reports && [...reports.values()].find(report => report.type === "inbound-rtp" && report.kind === "video");
      return { attached: true, connection: value.connection, roomName: room?.name,
        hostMatches: room?.delivery?.hostSessionId === config.hostSessionId, reading: room?.reading,
        base: first && { observedPcIndex: seen.indexOf(first) + 1, connection: first.pc.connectionState, ice: first.pc.iceConnectionState,
          current: active?.transport.pc === first.pc, selected: await selected(first.pc) },
        observedNativePcs: seen.filter(entry => entry.peerId === config.hostSessionId).length,
        historyComplete: !!value.historyByRoom[config.roomId] && !value.pending.has(`history:${config.roomId}`),
        confirmationSeq: !value.pending.has(`chat:${config.roomId}`) ? confirmation?.seq : null,
        chatDraftCleared: document.querySelector(".c3-composer textarea")?.value === "",
        publicationExists: !!publication,
        sourceMatches: publication?.kind === "screen" && publication.roomId === config.roomId && publication.sessionId === config.sourceSessionId,
        picture: video && inbound && { flowId: input.flowId, pairId: flowPair.id, trackId: track.id, ssrc: inbound.ssrc,
          parent: flowPair.peerId === config.hostSessionId ? "room-host" : flowPair.peerId === config.sourceSessionId ? "native-source" : "other-peer",
          codec: reports.get(inbound.codecId)?.mimeType, decoded: inbound.framesDecoded ?? 0,
          presented: video.getVideoPlaybackQuality().totalVideoFrames, time: video.currentTime,
          width: video.videoWidth, height: video.videoHeight, paused: video.paused, composited: video.dataset.composited === "true" } };
    },
    async latestHistory(roomId, nonce, seq) {
      const current = find(), previous = current.getSnapshot().historyByRoom[roomId];
      const loading = current.loadLatestHistory(roomId);
      // request() awaits the already-ready reading before registering this request.
      await Promise.resolve();
      const response = [...current.requests.values()].find(request => request.roomId === roomId && request.history)?.history;
      await loading;
      const value = current.getSnapshot();
      return { replaced: !!previous && previous !== value.historyByRoom[roomId],
        completed: !value.pending.has(`history:${roomId}`),
        received: !!response && [...response.entries.values()].some(entry => entry.message?.text === nonce && entry.message.seq === seq) };
    },
    picture(publicationId) {
      const stream = find().getSnapshot().screenInputs.get(publicationId)?.find(input => input.selected)?.stream;
      const video = [...document.querySelectorAll('video[data-selected="true"]')].find(video => video.srcObject === stream);
      const canvas = document.createElement("canvas"), scale = Math.min(320 / video.videoWidth, 180 / video.videoHeight, 1);
      canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png").split(",")[1];
    },
  };
}

async function main() {
  assert(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === "--check-contract", "unexpected_lab_arguments");
  const config = readContract(process.env.CHANNEL_PUBLIC_LAB);
  if (process.argv.includes("--check-contract")) { console.log("Public-peer contract valid (member scope, temporary origin)."); return; }
  const output = resolve(process.env.CHANNEL_ACCEPTANCE_OUTPUT ?? "build/channel-public-peer");
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), "piik-public-peer-"));
  const init = join(directory, "observer.js"), session = `public-peer-${randomUUID()}`;
  await writeFile(init, `(${installObserver.toString()})();`);
  const binary = process.env.AGENT_BROWSER_BIN ?? "agent-browser";
  const start = Date.now(), deadline = start + 180_000, nonce = `public-peer-${randomUUID()}`;
  const result = { passed: false, sourceRevision: process.env.GITHUB_SHA ?? null,
    runner: { platform: process.platform, architecture: process.arch, node: process.version, image: process.env.ImageVersion ?? null },
    normalApp: { revision: config.appRevision, apkSha256: config.apkSha256, identitySource: "local normal-package receipt" }, checks: {}, cleanup: false };
  let last, stage = "open", launched = false;
  const command = (args, cleanup = false) => new Promise((resolve, reject) => {
    const child = spawn(binary, ["--session", session, "--profile", join(directory, "profile"), "--init-script", init,
      ...(process.env.AGENT_BROWSER_EXECUTABLE_PATH ? ["--executable-path", process.env.AGENT_BROWSER_EXECUTABLE_PATH] : []),
      "--args", "--no-sandbox,--autoplay-policy=no-user-gesture-required", "--json", ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", exited = false, done = false;
    const finish = (error, data) => {
      if (done) return;
      done = true; clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy();
      if (error) reject(error); else resolve(data);
    };
    const complete = () => {
      if (!exited || done) return;
      let response; try { response = JSON.parse(stdout); } catch { return; }
      if (response.success) finish(null, response.data);
      else finish(new Error(`browser_${args[0]}_failed`));
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`browser_${args[0]}_timeout`)); }, cleanup ? 10_000 : Math.max(1, Math.min(30_000, deadline - Date.now())));
    child.stdout.on("data", chunk => { stdout += chunk; complete(); }); child.stderr.on("data", () => {});
    child.once("error", () => finish(new Error(`browser_${args[0]}_start_failed`)));
    // The daemon may inherit a CLI pipe. Require exit and complete JSON, not EOF.
    child.once("exit", code => { exited = true; if (code === 0) complete(); else finish(new Error(`browser_${args[0]}_failed`)); });
    child.once("close", () => { if (!done) finish(new Error(`browser_${args[0]}_incomplete`)); });
  });
  const evaluate = async expression => {
    const data = await command(["eval", "-b", Buffer.from(`(async()=>JSON.stringify(await (${expression})))()`).toString("base64")]);
    return JSON.parse(data.result);
  };
  const click = async selector => {
    await command(["scrollintoview", selector]);
    await command(["click", selector]);
  };
  const sample = () => evaluate(`window.__publicPeer.sample(${JSON.stringify(config)},${JSON.stringify(nonce)})`);
  const wait = async (name, condition) => {
    stage = name; console.log(JSON.stringify({ stage, elapsedMs: Date.now() - start }));
    while (Date.now() < deadline) {
      last = await sample();
      if (last.base && ["failed", "closed"].includes(last.base.connection)) throw new Error("first_observed_native_pair_failed");
      if (last.base?.ice === "failed") throw new Error("first_observed_native_ice_failed");
      if (last.publicationExists && !last.sourceMatches) throw new Error("publication_source_mismatch");
      if (condition(last)) return last;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`deadline_${name}`);
  };
  const readingReady = value => value.connection === "connected" && value.hostMatches && value.reading;
  const baseReady = value => readingReady(value) && value.base?.current
    && value.base.connection === "connected" && value.base.selected?.channels.some(channel => channel.state === "open")
    && independentEgress(value.base.selected);
  try {
    launched = true;
    await command(["set", "viewport", "1280", "900"]);
    await command(["open", config.inviteURL]);
    result.browser = await evaluate("navigator.userAgent");
    await wait("room", value => value.connection === "connected" && value.hostMatches && value.roomName);
    await click(`.c3-room-link[aria-label=${JSON.stringify(last.roomName)}]`);
    await wait("signed-history", value => readingReady(value) && value.historyComplete);
    result.checks.historyComplete = true;
    await command(["fill", ".c3-composer textarea", nonce]);
    await click('.c3-composer button[type="submit"]');
    await wait("signed-chat", value => readingReady(value) && value.chatDraftCleared && Number.isSafeInteger(value.confirmationSeq) && value.confirmationSeq > 0);
    result.checks.confirmationSeq = last.confirmationSeq;
    stage = "signed-history-readback";
    console.log(JSON.stringify({ stage, elapsedMs: Date.now() - start }));
    const readback = await evaluate(`window.__publicPeer.latestHistory(${JSON.stringify(config.roomId)},${JSON.stringify(nonce)},${result.checks.confirmationSeq})`);
    result.checks.historyReadback = readback;
    assert(readback.completed && readback.replaced && readback.received, "signed_history_readback_failed");
    await wait("native-publication", value => value.sourceMatches);
    await click(`.c3-monitor-offer[data-source-id=${JSON.stringify(config.publicationId)}] button:is([aria-label="Watch"], [aria-label="观看"])`);
    await wait("native-base", baseReady);
    result.checks.nativeBase = true;
    let before;
    await wait("h264-picture", value => {
      const picture = value.picture;
      if (!baseReady(value) || !picture || picture.codec?.toLowerCase() !== "video/h264" || !picture.composited || picture.paused) return false;
      const identity = JSON.stringify([picture.flowId, picture.trackId, picture.pairId, picture.ssrc]);
      if (!before || before.identity !== identity) before = { ...picture, identity };
      return picture.decoded >= before.decoded + 30 && picture.presented >= before.presented + 30
        && picture.time > before.time && picture.width > 0 && picture.height > 0;
    });
    result.checks.picture = { codec: last.picture.codec, width: last.picture.width, height: last.picture.height,
      parent: last.picture.parent, newDecoded: last.picture.decoded - before.decoded, newPresented: last.picture.presented - before.presented };
    await writeFile(join(output, "picture.png"), Buffer.from(await evaluate(`window.__publicPeer.picture(${JSON.stringify(config.publicationId)})`), "base64"));
    result.passed = true;
  } catch (error) {
    result.failure = { stage, code: /^[a-z0-9_-]+$/.test(error.message) ? error.message : "public_peer_check_failed" };
  } finally {
    result.elapsedMs = Date.now() - start;
    if (last) result.observation = { connection: last.connection, hostMatches: last.hostMatches, sourceMatches: last.sourceMatches,
      historyComplete: last.historyComplete, confirmationSeq: last.confirmationSeq, observedNativePcs: last.observedNativePcs,
      picture: last.picture && Object.fromEntries(Object.entries(last.picture).filter(([key]) => !["flowId", "pairId", "trackId", "ssrc"].includes(key))),
      firstObservedNative: last.base && { observedPcIndex: last.base.observedPcIndex, connection: last.base.connection, ice: last.base.ice, current: last.base.current,
        independentEgress: independentEgress(last.base.selected), selected: last.base.selected && Object.fromEntries(Object.entries(last.base.selected)
          .filter(([key]) => ["protocol", "localType", "remoteType", "requests", "responses", "bytesSent", "bytesReceived", "channels"].includes(key))) } };
    try { if (launched) await command(["close"], true); result.cleanup = true; }
    catch { result.passed = false; result.cleanupError = "browser_close_failed"; }
    assert(!relative(tmpdir(), directory).startsWith("..") && basename(directory).startsWith("piik-public-peer-"));
    if (result.cleanup) await rm(directory, { recursive: true, force: true });
    await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  }
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(/^[a-z0-9_-]+$/.test(error.message) ? error.message : "public_peer_setup_failed"); process.exitCode = 1; });
}
