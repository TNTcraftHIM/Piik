import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { AccessToken, TrackSource } from "livekit-server-sdk";

import {
  CdpConnection,
  cleanupRun,
  createPage,
  reservePort,
  waitForVersion,
  type PageHandle,
} from "./native-one-viewer-gate";

const WIDTH = 1_920;
const HEIGHT = 1_080;
const FRAME_RATE = 30;
const MAX_BITRATE = 5_000_000;
const SETTLE_MS = 5_000;
const SAMPLE_MS = 10_000;

interface RuntimeResult<T> {
  result: { value?: T };
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string };
  };
}

interface ProcessInfo {
  type: string;
  id: number;
  cpuTime: number;
}

interface ProcessSnapshot {
  processInfo: ProcessInfo[];
}

async function evaluate<T>(
  cdp: CdpConnection,
  page: PageHandle,
  expression: string,
  timeoutMs: number,
): Promise<T> {
  const value = await cdp.call<RuntimeResult<T>>(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    },
    page.sessionId,
    Date.now() + timeoutMs,
  );
  if (value.exceptionDetails) {
    throw new Error(
      value.exceptionDetails.exception?.description ??
        value.exceptionDetails.text ??
        "Browser evaluation failed",
    );
  }
  return value.result.value as T;
}

function sourceHtml(): string {
  return `<!doctype html><title>Codec Preflight Source</title>
<style>html,body{margin:0;overflow:hidden;background:#000}canvas{display:block;width:100vw;height:100vh}</style>
<canvas width="${WIDTH}" height="${HEIGHT}"></canvas><script>
const c=document.querySelector('canvas'),x=c.getContext('2d',{alpha:false});let f=0;
function draw(){f+=1;for(let r=0;r<14;r+=1)for(let q=0;q<24;q+=1){
x.fillStyle='hsl('+((f*29+r*71+q*43)%360)+' 80% '+(35+(f+r+q)%30)+'%)';
x.fillRect(q*80,r*78,80,78)}x.fillStyle='#fff';x.fillRect(f*13%1920,0,12,1080);
x.fillStyle='#000';x.font='60px monospace';x.fillText(String(f).padStart(8,'0'),24,72)}
draw();setInterval(draw,1000/${FRAME_RATE});</script>`;
}

async function startServer(port: number): Promise<Server> {
  const livekitBundle = await readFile(
    resolve("node_modules/livekit-client/dist/livekit-client.umd.js"),
  );
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
    if (path === "/livekit.js") {
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.end(livekitBundle);
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(path === "/source"
      ? sourceHtml()
      : "<!doctype html><title>Codec Preflight</title><script src='/livekit.js'></script><video autoplay muted playsinline style='width:960px'></video>");
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  return server;
}

function browserProbe(): string {
  return `(() => {
    const WIDTH=${WIDTH},HEIGHT=${HEIGHT},FRAME_RATE=${FRAME_RATE},MAX_BITRATE=${MAX_BITRATE};
    const SETTLE_MS=${SETTLE_MS},SAMPLE_MS=${SAMPLE_MS};let stream=null,track=null;
    const delay=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
    async function waitFor(predicate,timeout,label){const deadline=performance.now()+timeout;
      while(performance.now()<deadline){if(await predicate())return;await delay(50)}
      throw new Error('Timed out waiting for '+label)}
    function preferences(codec){const all=RTCRtpSender.getCapabilities('video')?.codecs||[];
      const mime=codec==='h264'?'video/h264':'video/vp8';const primary=all.filter((item)=>item.mimeType.toLowerCase()===mime);
      if(!primary.length)throw new Error(mime+' unavailable');
      const repair=new Set(['video/rtx','video/red','video/ulpfec','video/flexfec-03']);
      return [...primary,...all.filter((item)=>repair.has(item.mimeType.toLowerCase()))]}
    async function gathered(pc){if(pc.iceGatheringState==='complete')return;
      await new Promise((resolve)=>{const changed=()=>{if(pc.iceGatheringState!=='complete')return;
        pc.removeEventListener('icegatheringstatechange',changed);resolve()};pc.addEventListener('icegatheringstatechange',changed)})}
    async function negotiate(a,b){await a.setLocalDescription(await a.createOffer());await gathered(a);
      await b.setRemoteDescription(a.localDescription);await b.setLocalDescription(await b.createAnswer());
      await gathered(b);await a.setRemoteDescription(b.localDescription)}
    function statsValue(item){if(!item)return null;const keys=['id','timestamp','bytesSent','bytesReceived',
      'framesEncoded','framesDecoded','framesDropped','framesPerSecond','frameWidth','frameHeight','totalEncodeTime',
      'totalDecodeTime','qualityLimitationReason','qualityLimitationDurations','encoderImplementation',
      'decoderImplementation','powerEfficientEncoder','powerEfficientDecoder','frames'];const value={};
      for(const key of keys)value[key]=item[key]??null;return value}
    async function snapshot(sender,receiver,rendered){const [sendReport,receiveReport]=await Promise.all([sender.getStats(),receiver.getStats()]);
      let outbound=null,inbound=null;sendReport.forEach((item)=>{if(item.type==='outbound-rtp'&&item.kind==='video'&&!item.isRemote)outbound=item});
      receiveReport.forEach((item)=>{if(item.type==='inbound-rtp'&&item.kind==='video'&&!item.isRemote)inbound=item});
      const sendCodec=outbound?.codecId?sendReport.get(outbound.codecId):null;
      const receiveCodec=inbound?.codecId?receiveReport.get(inbound.codecId):null;
      const mediaSource=outbound?.mediaSourceId?sendReport.get(outbound.mediaSourceId):null;
      const codec=(item)=>item?{mimeType:item.mimeType||null,sdpFmtpLine:item.sdpFmtpLine||null}:null;
      return {rendered:rendered(),sender:statsValue(outbound),receiver:statsValue(inbound),
        mediaSource:statsValue(mediaSource),senderCodec:codec(sendCodec),receiverCodec:codec(receiveCodec)}}
    function delta(after,before,key){const a=after?.[key],b=before?.[key];return Number.isFinite(a)&&Number.isFinite(b)&&a>=b?a-b:null}
    function summarize(before,after,sampleMs){const encoded=delta(after.sender,before.sender,'framesEncoded');
      const decoded=delta(after.receiver,before.receiver,'framesDecoded');const bytes=delta(after.sender,before.sender,'bytesSent');
      const sourceFrames=delta(after.mediaSource,before.mediaSource,'frames');
      const encodeTime=delta(after.sender,before.sender,'totalEncodeTime');const decodeTime=delta(after.receiver,before.receiver,'totalDecodeTime');
      return {senderCodec:after.senderCodec,receiverCodec:after.receiverCodec,sender:after.sender,receiver:after.receiver,
        measured:{sampleMs,encodedFps:encoded===null?null:encoded*1000/sampleMs,
          decodedFps:decoded===null?null:decoded*1000/sampleMs,bitrateKbps:bytes===null?null:bytes*8/sampleMs,
          encodeMsPerFrame:encodeTime!==null&&encoded>0?encodeTime*1000/encoded:null,
          decodeMsPerFrame:decodeTime!==null&&decoded>0?decodeTime*1000/decoded:null,
          sourceFps:sourceFrames===null?after.mediaSource?.framesPerSecond:sourceFrames*1000/sampleMs,
          encodedSourceRatio:sourceFrames>0&&encoded!==null?encoded/sourceFrames:null,
          renderedFrames:delta(after,before,'rendered')}}}
    async function setup(){stream=await navigator.mediaDevices.getDisplayMedia({video:{
      width:{ideal:WIDTH,max:WIDTH},height:{ideal:HEIGHT,max:HEIGHT},frameRate:{ideal:FRAME_RATE,max:FRAME_RATE}},audio:false});
      track=stream.getVideoTracks()[0];if(!track)throw new Error('No display video track');track.contentHint='motion';
      return {settings:track.getSettings(),constraints:track.getConstraints(),contentHint:track.contentHint,label:track.label}}
    function capabilities(){const simple=(codec)=>({mimeType:codec.mimeType,sdpFmtpLine:codec.sdpFmtpLine||null});
      return {sender:(RTCRtpSender.getCapabilities('video')?.codecs||[]).map(simple),
        receiver:(RTCRtpReceiver.getCapabilities('video')?.codecs||[]).map(simple)}}
    async function edge(codec,sourceTrack){
      const sendPc=new RTCPeerConnection({iceServers:[]}),receivePc=new RTCPeerConnection({iceServers:[]});
      const transceiver=sendPc.addTransceiver(sourceTrack,{direction:'sendonly'});transceiver.setCodecPreferences(preferences(codec));
      let receiver=null,remoteTrack=null;receivePc.addEventListener('track',(event)=>{receiver=event.receiver;remoteTrack=event.track});
      await negotiate(sendPc,receivePc);await waitFor(()=>sendPc.connectionState==='connected'&&receivePc.connectionState==='connected',10000,'connection');
        await waitFor(()=>receiver&&remoteTrack,5000,'remote track');const video=document.createElement('video');let rendered=0;
        video.autoplay=true;video.muted=true;video.playsInline=true;document.body.append(video);
        video.srcObject=new MediaStream([remoteTrack]);if(video.requestVideoFrameCallback){const frame=()=>{rendered+=1;video.requestVideoFrameCallback(frame)};video.requestVideoFrameCallback(frame)}
        await video.play();const parameters=transceiver.sender.getParameters();if(!parameters.encodings.length)parameters.encodings=[{}];
        parameters.encodings[0].maxBitrate=MAX_BITRATE;parameters.encodings[0].maxFramerate=FRAME_RATE;
        parameters.encodings[0].scaleResolutionDownBy=1;parameters.degradationPreference='balanced';await transceiver.sender.setParameters(parameters);
        await waitFor(async()=>{const report=await receiver.getStats();let frames=0;report.forEach((item)=>{if(item.type==='inbound-rtp'&&item.kind==='video')frames=Math.max(frames,item.framesDecoded||0)});return frames>0&&rendered>0},10000,'decoded frame');
        return {sendPc,receivePc,sender:transceiver.sender,receiver,remoteTrack,rendered:()=>rendered}}
    async function run(codec,count,topology){if(!track)throw new Error('Capture not initialized');const edges=[];
      try{edges.push(await edge(codec,track));
        if(topology==='relay')edges.push(await edge(codec,edges[0].remoteTrack));
        else for(let index=1;index<count;index+=1)edges.push(await edge(codec,track));await delay(SETTLE_MS);
        const before=await Promise.all(edges.map((item)=>snapshot(item.sender,item.receiver,item.rendered))),started=performance.now();
        await delay(SAMPLE_MS);const sampleMs=performance.now()-started;
        const after=await Promise.all(edges.map((item)=>snapshot(item.sender,item.receiver,item.rendered)));
        return edges.map((_,index)=>summarize(before[index],after[index],sampleMs))}
      finally{for(const item of edges){item.sendPc.close();item.receivePc.close()}await delay(300)}}
    async function runLivekit(codec,url,publisherToken,subscriberToken){if(!track)throw new Error('Capture not initialized');
      const sdk=globalThis.LivekitClient,publisher=new sdk.Room({dynacast:true}),subscriber=new sdk.Room();let remoteTrack=null,rendered=0;
      subscriber.on(sdk.RoomEvent.TrackSubscribed,(nextTrack)=>{if(nextTrack.kind==='video')remoteTrack=nextTrack});
      try{await publisher.connect(url,publisherToken,{autoSubscribe:false,rtcConfig:{iceServers:[]}});
        await subscriber.connect(url,subscriberToken,{rtcConfig:{iceServers:[]}});
        const publication=await publisher.localParticipant.publishTrack(track,{source:sdk.Track.Source.ScreenShare,
          videoCodec:codec,backupCodec:false,screenShareEncoding:{maxBitrate:MAX_BITRATE,maxFramerate:FRAME_RATE},
          degradationPreference:'balanced'});
        await waitFor(()=>publication.videoTrack?.sender&&remoteTrack,15000,'LiveKit publication');
        const video=document.createElement('video');video.autoplay=true;video.muted=true;video.playsInline=true;document.body.append(video);
        video.srcObject=new MediaStream([remoteTrack.mediaStreamTrack]);if(video.requestVideoFrameCallback){const frame=()=>{rendered+=1;video.requestVideoFrameCallback(frame)};video.requestVideoFrameCallback(frame)}
        await video.play();const receiver={getStats:async()=>{const report=await remoteTrack.getRTCStatsReport();if(!report)throw new Error('LiveKit receiver stats unavailable');return report}};
        await waitFor(async()=>{const report=await receiver.getStats();let frames=0;report?.forEach((item)=>{if(item.type==='inbound-rtp'&&item.kind==='video')frames=Math.max(frames,item.framesDecoded||0)});return frames>0&&rendered>0},15000,'LiveKit decoded frame');
        await delay(SETTLE_MS);const sender=publication.videoTrack.sender;
        const before=await snapshot(sender,receiver,()=>rendered),started=performance.now();await delay(SAMPLE_MS);
        const sampleMs=performance.now()-started,after=await snapshot(sender,receiver,()=>rendered);
        return {...summarize(before,after,sampleMs),senderParameters:sender.getParameters()}}
      finally{await Promise.allSettled([publisher.disconnect(false),subscriber.disconnect(false)]);await delay(300)}}
    function stop(){stream?.getTracks().forEach((item)=>item.stop())}
    Object.defineProperty(globalThis,'__CODEC_PREFLIGHT__',{value:{setup,capabilities,run,runLivekit,stop}});
  })()`;
}

async function processSnapshot(cdp: CdpConnection): Promise<ProcessSnapshot> {
  return cdp.call<ProcessSnapshot>(
    "SystemInfo.getProcessInfo",
    {},
    undefined,
    Date.now() + 5_000,
  );
}

function processCpu(
  before: ProcessSnapshot,
  after: ProcessSnapshot,
  wallMs: number,
): Record<string, unknown> {
  const baseline = new Map(
    before.processInfo.map((item) => [`${item.type}:${item.id}`, item.cpuTime]),
  );
  let cpuSeconds = 0;
  let stableProcesses = 0;
  for (const item of after.processInfo) {
    const previous = baseline.get(`${item.type}:${item.id}`);
    if (previous === undefined || item.cpuTime < previous) continue;
    cpuSeconds += item.cpuTime - previous;
    stableProcesses += 1;
  }
  const wallSeconds = wallMs / 1_000;
  return {
    wallSeconds,
    cpuSeconds,
    logicalCoreEquivalent: cpuSeconds / wallSeconds,
    stableProcesses,
    processIdentityChanged:
      stableProcesses !== before.processInfo.length ||
      stableProcesses !== after.processInfo.length,
  };
}

async function main(): Promise<void> {
  const chromePath = process.env.CHROME_PATH?.trim();
  if (!chromePath) throw new Error("CHROME_PATH must point to Chrome");
  const codec = process.env.CODEC_PREFLIGHT_CODEC?.trim().toLowerCase();
  if (codec !== "vp8" && codec !== "h264") {
    throw new Error("CODEC_PREFLIGHT_CODEC must be vp8 or h264");
  }
  const edges = Number(process.env.CODEC_PREFLIGHT_EDGES ?? "1");
  if (edges !== 1 && edges !== 2) {
    throw new Error("CODEC_PREFLIGHT_EDGES must be 1 or 2");
  }
  const topology = process.env.CODEC_PREFLIGHT_TOPOLOGY?.trim() || "direct";
  if (topology !== "direct" && topology !== "relay" && topology !== "livekit") {
    throw new Error("CODEC_PREFLIGHT_TOPOLOGY must be direct, relay, or livekit");
  }
  const [debugPort, pagePort] = await Promise.all([reservePort(), reservePort()]);
  const profile = await mkdtemp(join(tmpdir(), "screener-codec-preflight-"));
  let chrome: ChildProcessWithoutNullStreams | null = null;
  let cdp: CdpConnection | null = null;
  let server: Server | null = null;
  try {
    server = await startServer(pagePort);
    chrome = spawn(chromePath, [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--autoplay-policy=no-user-gesture-required",
      "--auto-select-tab-capture-source-by-title=Codec Preflight Source",
      "--window-size=1920,1080",
      "about:blank",
    ], { stdio: "pipe", windowsHide: true });
    chrome.stdout.resume();
    chrome.stderr.resume();
    const version = await waitForVersion(debugPort, chrome);
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, Date.now() + 5_000);
    const gpuInfo = await cdp.call<unknown>("SystemInfo.getInfo", {}, undefined, Date.now() + 5_000);
    await createPage(cdp, `http://127.0.0.1:${pagePort}/source`, undefined, true);
    const page = await createPage(cdp, `http://127.0.0.1:${pagePort}/test`, undefined, true);
    await evaluate<void>(cdp, page, browserProbe(), 5_000);
    const capabilities = await evaluate<unknown>(
      cdp,
      page,
      "globalThis.__CODEC_PREFLIGHT__.capabilities()",
      5_000,
    );
    const capture = await evaluate<unknown>(
      cdp,
      page,
      "globalThis.__CODEC_PREFLIGHT__.setup()",
      15_000,
    );
    const before = await processSnapshot(cdp);
    const started = performance.now();
    let media: unknown;
    if (topology === "livekit") {
      const livekitUrl = process.env.CODEC_PREFLIGHT_LIVEKIT_URL?.trim();
      const apiKey = process.env.CODEC_PREFLIGHT_LIVEKIT_KEY?.trim();
      const apiSecret = process.env.CODEC_PREFLIGHT_LIVEKIT_SECRET?.trim();
      if (!livekitUrl || !apiKey || !apiSecret) {
        throw new Error("LiveKit preflight credentials are missing");
      }
      const room = `codec-preflight-${Date.now()}`;
      const token = async (identity: string, publish: boolean) => {
        const access = new AccessToken(apiKey, apiSecret, { identity, ttl: 60 });
        access.addGrant({
          roomJoin: true,
          room,
          canPublish: publish,
          canPublishSources: publish ? [TrackSource.SCREEN_SHARE] : undefined,
          canSubscribe: !publish,
          canPublishData: false,
        });
        return access.toJwt();
      };
      const [publisherToken, subscriberToken] = await Promise.all([
        token("host", true),
        token("viewer", false),
      ]);
      media = await evaluate<unknown>(
        cdp,
        page,
        `globalThis.__CODEC_PREFLIGHT__.runLivekit(${JSON.stringify(codec)}, ${JSON.stringify(livekitUrl)}, ${JSON.stringify(publisherToken)}, ${JSON.stringify(subscriberToken)})`,
        60_000,
      );
    } else {
      media = await evaluate<unknown>(
        cdp,
        page,
        `globalThis.__CODEC_PREFLIGHT__.run(${JSON.stringify(codec)}, ${edges}, ${JSON.stringify(topology)})`,
        45_000,
      );
    }
    const wallMs = performance.now() - started;
    const after = await processSnapshot(cdp);
    await evaluate<void>(cdp, page, "globalThis.__CODEC_PREFLIGHT__.stop()", 5_000);
    const report = {
      schemaVersion: 1,
      browser: version.Browser,
      configuration: {
        width: WIDTH,
        height: HEIGHT,
        frameRate: FRAME_RATE,
        maxBitrate: MAX_BITRATE,
        contentHint: "motion",
        settleMs: SETTLE_MS,
        sampleMs: SAMPLE_MS,
        edges,
        topology,
      },
      gpuInfo,
      capabilities,
      capture,
      codec,
      media,
      cpu: processCpu(before, after, wallMs),
    };
    const outputDirectory = resolve("benchmark-results");
    await mkdir(outputDirectory, { recursive: true });
    const output = join(
      outputDirectory,
      `browser-codec-preflight-${codec}-${topology}-${edges}.json`,
    );
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(output);
  } finally {
    await cleanupRun({
      cdp,
      native: null,
      chrome,
      server: null,
      profile,
      ports: [debugPort],
    });
    if (server) {
      await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
    }
  }
}

await main();
