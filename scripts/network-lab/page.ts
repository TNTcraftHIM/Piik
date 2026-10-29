// Synthetic capture is the only media substitution. PeerConnection, signaling,
// candidate selection and readiness remain the production implementation.
export const pageProbe = String.raw`(() => {
  localStorage.setItem('silip:ui-lang','en'); localStorage.setItem('silip:ui-mode','text');
  const peers=[], sockets=[], events=[], errors=[], controls=[];
  let route=null,upstream=null,natPrediction=null,voice=null,freezeCapture=()=>{},resumeCapture=()=>{},peerSignalDelay=0,peerSignalReleaseAt=0;
  let observedVideo=null,frameCallback=0,renderedFrames=0,lastFrameAt=0,maxFrameGapMs=0;
  const observeVideo=video=>{
    if(video===observedVideo)return;
    observedVideo?.cancelVideoFrameCallback(frameCallback);observedVideo=video;
    if(!video)return;
    const frame=now=>{
      if(video!==observedVideo)return;
      if(lastFrameAt)maxFrameGapMs=Math.max(maxFrameGapMs,now-lastFrameAt);
      lastFrameAt=now;renderedFrames++;frameCallback=video.requestVideoFrameCallback(frame);
    };frameCallback=video.requestVideoFrameCallback(frame);
  };
  const PC=RTCPeerConnection, WS=WebSocket;
  const picture=document.createElement('canvas');picture.width=64;picture.height=36;
  const pictureContext=picture.getContext('2d',{willReadFrequently:true});
  const record=(list,value)=>{ list.push(value); if(list.length>240)list.shift(); };
  window.addEventListener('unhandledrejection', e=>record(errors,String(e.reason)));
  window.RTCPeerConnection=class extends PC { constructor(...args){super(...args);const peerId=peers.push(this)-1;
    this.addEventListener('icecandidate',e=>record(events,{at:performance.now(),type:'ice-candidate',peerId,candidate:e.candidate?.candidate}));
    this.addEventListener('icecandidateerror',e=>record(events,{at:performance.now(),type:'ice-error',peerId,code:e.errorCode,reason:e.errorText,url:e.url}));
  } };
  window.WebSocket=class extends WS {
    constructor(...args){ super(...args); sockets.push(this);
      const scope=this.url.includes('/control')?'app':'room';
      for(const type of ['open','close','error'])this.addEventListener(type,()=>record(events,{at:performance.now(),type:'ws-'+type,scope}));
      this.addEventListener('message', event=>{
        let message; try{message=JSON.parse(event.data);}catch{return;}
        if(typeof message.routePolicy?.natPrediction==='boolean')natPrediction=message.routePolicy.natPrediction;
        if(message.type==='route-update'&&message.phase==='active'){
          upstream=message.assignment.upstream;route=upstream.kind;
        }
        if(message.type==='room-voice-state')voice=message;
        const value={at:performance.now(),type:message.type,state:message.state,reason:message.reason,scope,
          phase:message.phase,route:message.assignment?.upstream?.kind,connectionId:message.connectionId};
        if(message.type==='signal'&&message.payload?.kind==='description'){
          value.fromPeerId=message.fromPeerId;value.connectionId=message.payload.connectionId;
          value.descriptionType=message.payload.description.type;
        }
        if(message.type==='punch-prepared')value.predictionStep=message.prediction?.step;
        if(message.type==='punch-complete')value.connected=message.connected;
        for(const key of ['localType','remoteType','natTraversalPath','sampleWindowMs','intervalFramesEncoded',
          'framesPerSecond','bitrateKbps','availableOutgoingKbps','width','height'])if(message[key]!==undefined)value[key]=message[key];
        record(events,value);
      });
    }
    send(raw){
      let m;try{m=JSON.parse(raw);}catch{}
      if(this.url.includes('/control')){
        if(m)record(controls,{type:m.type,connectionId:m.connectionId,punched:m.punched});
      }else if(m?.type==='signal'&&peerSignalDelay>0){
        // Delay real signaling once; never invent SDP, route state or readiness.
        if(!peerSignalReleaseAt)peerSignalReleaseAt=performance.now()+peerSignalDelay;
        const remaining=peerSignalReleaseAt-performance.now();
        if(remaining>0){
          record(events,{at:performance.now(),type:'test-signal-delayed',connectionId:m.connectionId});
          setTimeout(()=>{if(this.readyState===WS.OPEN)super.send(raw);},remaining);return;
        }
      }
      super.send(raw);
    }
  };
  navigator.mediaDevices.getDisplayMedia=async()=>{
    const canvas=document.createElement('canvas'); canvas.width=1280; canvas.height=720;
    const ctx=canvas.getContext('2d');let frame=0;
    const draw=()=>{ctx.fillStyle='#19292f';ctx.fillRect(0,0,1280,720);
      // Deterministic moving detail puts real pressure on a constrained encoder.
      for(let y=0;y<12;y++)for(let x=0;x<20;x++){
        ctx.fillStyle='hsl('+((x*37+y*19+frame*3)%360)+' 65% 55%)';
        ctx.fillRect((x*64+frame*7)%1280,y*60,45,42);
      }
      ctx.fillStyle='#fff';ctx.font='70px sans-serif';ctx.fillText(String(frame++),80,540);};
    draw();let timer=setInterval(draw,1000/30);const stream=canvas.captureStream(30);
    freezeCapture=()=>{clearInterval(timer);timer=null;};
    resumeCapture=()=>{if(!timer)timer=setInterval(draw,1000/30);};
    const video=stream.getVideoTracks()[0],stop=video.stop.bind(video);
    video.stop=()=>{clearInterval(timer);stop();};
    const ac=new AudioContext(),osc=ac.createOscillator(),dest=ac.createMediaStreamDestination();
    osc.frequency.value=440;osc.connect(dest);osc.start();await ac.resume();
    const sound=dest.stream.getAudioTracks()[0],stopSound=sound.stop.bind(sound);let stopped=false;
    sound.stop=()=>{if(stopped)return;stopped=true;osc.stop();void ac.close();stopSound();};
    stream.addTrack(sound);return stream;
  };
  window.networkLab={async voiceSample(){
    const audio=[...document.querySelectorAll('audio')].filter(node=>node.srcObject);
    const ids=new Set(audio.flatMap(node=>node.srcObject.getAudioTracks().map(track=>track.id)));
    let energy=0,samples=0;
    for(const peer of peers)if(peer.connectionState==='connected')for(const row of (await peer.getStats()).values())
      if(row.type==='inbound-rtp'&&row.kind==='audio'&&ids.has(row.trackIdentifier)){
        energy+=row.totalAudioEnergy||0;samples+=row.totalSamplesDuration||0;
      }
    return {energy,samples,playing:audio.length,publications:voice?.publications.length||0};
  },freezeCapture:()=>freezeCapture(),resumeCapture:()=>resumeCapture(),delayPeerSignals:ms=>{peerSignalDelay=ms;peerSignalReleaseAt=0;},
    restartUpstream:()=>{
      const socket=sockets.findLast(s=>!s.url.includes('/control')&&s.readyState===WS.OPEN);
      const offer=events.findLast(event=>event.type==='signal'&&event.fromPeerId===upstream?.peerId&&event.descriptionType==='offer');
      if(!socket||upstream?.kind!=='peer'||!offer)return false;
      socket.send(JSON.stringify({type:'restart-request',targetPeerId:upstream.peerId,
        connectionId:offer.connectionId,rebuild:false}));return true;
    },
    resetPlaybackProgress:()=>{renderedFrames=0;lastFrameAt=performance.now();maxFrameGapMs=0;},async signalProbe(){
    const socket=sockets.findLast(s=>!s.url.includes('/control')&&s.readyState===WS.OPEN);
    if(!socket)return false;
    return new Promise(resolve=>{
      const finish=value=>{clearTimeout(timer);socket.removeEventListener('message',receive);resolve(value);};
      const receive=event=>{try{if(JSON.parse(event.data).type==='route-diagnostic-snapshot')finish(true);}catch{}};
      const timer=setTimeout(()=>finish(false),1800);socket.addEventListener('message',receive);
      socket.send(JSON.stringify({type:'request-route-diagnostic'}));
    });
  },async sample(){
    const stats=[];
    for(const [peerId,peer] of peers.entries()){if(peer.connectionState==='closed')continue;
      const report=await peer.getStats();
      for(const row of report.values()){
        if(row.type==='candidate-pair')stats.push({type:'pair-state',peerId,state:row.state,
          requestsSent:row.requestsSent,responsesReceived:row.responsesReceived,localCandidateId:row.localCandidateId,remoteCandidateId:row.remoteCandidateId});
        if(row.type==='local-candidate'||row.type==='remote-candidate')stats.push({type:row.type,id:row.id,peerId,
          address:row.address,port:row.port,protocol:row.protocol,candidateType:row.candidateType});
        if(row.type==='inbound-rtp'||row.type==='outbound-rtp'||row.type==='remote-inbound-rtp'){
          const selected={type:row.type,kind:row.kind,id:row.id,peerId};
          for(const key of ['framesDecoded','framesReceived','framesEncoded','framesDropped','framesPerSecond',
            'frameWidth','frameHeight','bytesReceived','bytesSent','packetsLost','packetsReceived','nackCount','qpSum',
            'retransmittedPacketsReceived','retransmittedPacketsSent','freezeCount','totalFreezesDuration',
            'pliCount','totalDecodeTime','jitterBufferDelay','jitterBufferEmittedCount','totalAudioEnergy',
            'totalSamplesDuration','roundTripTime','reportsReceived','qualityLimitationReason','targetBitrate']){
            if(row[key]!==undefined)selected[key]=row[key];
          }stats.push(selected);
        }
        if(row.type==='candidate-pair'&&row.nominated&&row.state==='succeeded'){
          const local=report.get(row.localCandidateId),remote=report.get(row.remoteCandidateId);
          stats.push({type:'selected-pair',peerId,rtt:row.currentRoundTripTime,bwe:row.availableOutgoingBitrate,
            localType:local?.candidateType,remoteType:remote?.candidateType,protocol:remote?.protocol,
            localAddress:local?.address,remoteAddress:remote?.address,localPort:local?.port,remotePort:remote?.port});
        }
      }
    }
    const video=document.querySelector('video');
    observeVideo(video);
    const playbackTrack=video?.srcObject?.getVideoTracks?.()[0];
    const playbackPeerId=playbackTrack?peers.findIndex(peer=>peer.getReceivers().some(receiver=>receiver.track===playbackTrack)):-1;
    let pictureHash=null;
    if(video?.videoWidth&&video.readyState>=2){
      pictureContext.drawImage(video,0,0,64,36);let hash=2166136261;
      for(const byte of pictureContext.getImageData(0,0,64,36).data)hash=Math.imul(hash^byte,16777619);
      pictureHash=hash>>>0;
    }
    return{at:performance.now(),width:video?.videoWidth||0,height:video?.videoHeight||0,
      frames:video?.getVideoPlaybackQuality().totalVideoFrames||0,pictureHash,playbackPeerId,route,natPrediction,stats,events:[...events],errors:[...errors],controls:[...controls],
      playbackProgress:{renderedFrames,lastFrameAt,maxFrameGapMs:Math.max(maxFrameGapMs,lastFrameAt?performance.now()-lastFrameAt:0)},
      sharing:!!document.querySelector('button[aria-label="Stop sharing"]'),
      controlOpen:sockets.some(s=>s.url.includes('/control')&&s.readyState===WS.OPEN),
      controlOrigins:sockets.filter(s=>s.url.includes('/control')&&s.readyState===WS.OPEN).map(s=>new URL(s.url).origin),
      peerStates:peers.map(p=>p.connectionState),text:document.body.innerText.slice(-2000)};
  }};
})();`;

export interface MediaSample {
  at: number;
  width: number;
  height: number;
  frames: number;
  pictureHash: number | null;
  playbackPeerId: number;
  route: string | null;
  natPrediction: boolean | null;
  stats: Array<Record<string, string | number>>;
  events: Array<{ at: number; type: string; scope?: string; state?: string; reason?: string; phase?: string; route?: string;
    connectionId?: string; [key: string]: string | number | undefined }>;
  errors: string[];
  controls: Array<{ type: string; connectionId?: string }>;
  sharing: boolean;
  controlOpen: boolean;
  controlOrigins: string[];
  playbackProgress: { renderedFrames: number; lastFrameAt: number; maxFrameGapMs: number };
  peerStates: string[];
  text: string;
}
