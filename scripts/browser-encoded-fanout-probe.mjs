import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';

// Explicit local experiment, never part of product startup or ordinary CI.
const codec = process.argv.includes('--h264') ? 'H264' : 'VP8';
const lateJoin = process.argv.includes('--late-join');
const limited = process.argv.includes('--limit-secondary');
mkdirSync('build/encoder-pool', { recursive: true });
const html = `<!doctype html><meta charset="utf-8"><title>Encoded fanout probe</title>
<canvas id="source" width="640" height="360"></canvas>
<video id="a" autoplay muted playsinline></video><video id="b" autoplay muted playsinline></video>
<pre id="result">starting</pre><script>
const pc = [], tracks = [], errors = [];
let drawing = true, frame = 0, sharedFrames = 0, dummyFrames = 0;
const wait = ms => new Promise(r => setTimeout(r, ms));
const source = document.querySelector('#source');
const ctx = source.getContext('2d');
function draw() {
  ctx.fillStyle = '#162b38'; ctx.fillRect(0,0,640,360);
  ctx.fillStyle = '#58cf94'; ctx.fillRect((frame * 6) % 580,70,60,180);
  ctx.fillStyle = '#ffb94a'; ctx.font = '42px sans-serif'; ctx.fillText(String(frame++),30,50);
  if (drawing) requestAnimationFrame(draw);
}
draw();
function gather(connection) {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve,reject) => {
    const timer=setTimeout(()=>reject(Error('ICE gathering deadline')),5000);
    connection.addEventListener('icegatheringstatechange',()=>{
      if(connection.iceGatheringState==='complete'){ clearTimeout(timer); resolve(); }
    });
  });
}
async function pair(track,video) {
  const send=new RTCPeerConnection({encodedInsertableStreams:true,iceServers:[]});
  const receive=new RTCPeerConnection({iceServers:[]}); pc.push(send,receive);
  receive.ontrack=e=>{video.srcObject=new MediaStream([e.track]); video.play().catch(()=>{});};
  const sender=send.addTrack(track,new MediaStream([track]));
  send.getTransceivers()[0].setCodecPreferences(RTCRtpSender.getCapabilities('video').codecs.filter(c=>c.mimeType==='video/${codec}'));
  const streams=sender.createEncodedStreams();
  return {send,receive,sender,streams,async connect(){
    await send.setLocalDescription(await send.createOffer()); await gather(send);
    await receive.setRemoteDescription(send.localDescription);
    await receive.setLocalDescription(await receive.createAnswer()); await gather(receive);
    await send.setRemoteDescription(receive.localDescription);
  }};
}
async function stats(connection) {
  return [...(await connection.getStats()).values()].filter(s=>(s.type==='inbound-rtp'||s.type==='outbound-rtp')&&s.kind==='video').map(s=>{
    const keys=['type','framesEncoded','framesDecoded','framesSent','framesReceived','frameWidth','frameHeight','framesPerSecond','bytesSent','bytesReceived','totalEncodeTime','qualityLimitationReason','targetBitrate','pliCount','nackCount'];
    return Object.fromEntries(keys.filter(k=>s[k]!==undefined).map(k=>[k,s[k]]));
  });
}
async function run() {
  if(!RTCRtpSender.prototype.createEncodedStreams) throw Error('legacy transform unavailable');
  const stream=source.captureStream(30);const main=stream.getVideoTracks()[0];tracks.push(main);
  const dummy=document.createElement('canvas');dummy.width=dummy.height=16;
  dummy.getContext('2d').fillRect(0,0,16,16);
  const dummyTrack=dummy.captureStream(0).getVideoTracks()[0]; tracks.push(dummyTrack);
  const A=await pair(main,document.querySelector('#a'));
  const B=await pair(dummyTrack,document.querySelector('#b'));
  ${limited ? "const parameters=B.sender.getParameters();parameters.encodings[0].maxBitrate=50000;await B.sender.setParameters(parameters);" : ''}
  const writerA=A.streams.writable.getWriter(),writerB=B.streams.writable.getWriter();
  const readerA=A.streams.readable.getReader(),readerB=B.streams.readable.getReader();
  const pumpA=(async()=>{for(;;){const r=await readerA.read();if(r.done)return;const copy=new RTCEncodedVideoFrame(r.value);await writerA.write(r.value);await writerB.write(copy);sharedFrames++;}})().catch(e=>errors.push(e.message));
  const pumpB=(async()=>{for(;;){const r=await readerB.read();if(r.done)return;dummyFrames++;}})().catch(e=>errors.push(e.message));
  ${lateJoin ? 'await A.connect();await wait(250);await B.connect();' : 'await B.connect();await A.connect();'}dummyTrack.requestFrame();
  await wait(7000);
  const result={codec:'${codec}',lateJoin:${lateJoin},secondaryMaxBitrate:B.sender.getParameters().encodings[0].maxBitrate??null,browser:navigator.userAgent,sharedFrames,dummyFrames,errors,
    aSend:await stats(A.send),bSend:await stats(B.send),aReceive:await stats(A.receive),bReceive:await stats(B.receive),
    aVideo:[document.querySelector('#a').videoWidth,document.querySelector('#a').videoHeight],
    bVideo:[document.querySelector('#b').videoWidth,document.querySelector('#b').videoHeight]};
  drawing=false;tracks.forEach(t=>t.stop());pc.forEach(p=>p.close());
  await readerA.cancel();await readerB.cancel();await Promise.allSettled([pumpA,pumpB]);
  return result;
}
window.probeDone=false;
run().then(async result=>{
  window.probeResult=result;window.probeDone=true;document.querySelector('#result').textContent=JSON.stringify(result,null,2);
  await fetch('/result',{method:'POST',body:JSON.stringify(result)});
}).catch(async e=>{
  drawing=false;tracks.forEach(t=>t.stop());pc.forEach(p=>p.close());
  window.probeResult={error:e.stack,errors};window.probeDone=true;
  document.querySelector('#result').textContent=JSON.stringify(window.probeResult);
  await fetch('/result',{method:'POST',body:JSON.stringify(window.probeResult)});
});
</script>`;

const timer = setTimeout(()=>server.close(),60000);
const server = http.createServer((req,res)=>{
  if(req.url==='/result'&&req.method==='POST'){
    let data='';req.on('data',chunk=>{data+=chunk;if(data.length>65536)req.destroy();});
    req.on('end',()=>{const result=JSON.parse(data);writeFileSync('build/encoder-pool/browser-fanout-'+codec.toLowerCase()+(lateJoin?'-late':'')+(limited?'-limited':'')+'.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));res.end('ok');clearTimeout(timer);server.close();});
  } else {res.setHeader('content-type','text/html');res.end(html);}
});
server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port));
