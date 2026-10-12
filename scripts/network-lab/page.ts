// Synthetic capture is the only media substitution. PeerConnection, signaling,
// candidate selection and readiness remain the production implementation.
export const pageProbe = String.raw`(() => {
  localStorage.setItem('piik:ui-lang','en'); localStorage.setItem('piik:ui-mode','text');
  const peers=[], sockets=[], events=[], errors=[], controls=[];
  const PC=RTCPeerConnection, WS=WebSocket;
  const record=(list,value)=>{ list.push(value); if(list.length>240)list.shift(); };
  window.addEventListener('unhandledrejection', e=>record(errors,String(e.reason)));
  window.RTCPeerConnection=class extends PC { constructor(...args){super(...args); peers.push(this);} };
  window.WebSocket=class extends WS {
    constructor(...args){ super(...args); sockets.push(this);
      this.addEventListener('message', event=>{
        let message; try{message=JSON.parse(event.data);}catch{return;}
        record(events,{at:performance.now(),type:message.type,state:message.state,reason:message.reason,
          phase:message.phase,route:message.route?.kind});
      });
    }
    send(raw){if(this.url.includes('/control')){try{record(controls,JSON.parse(raw).type);}catch{}}super.send(raw);}
  };
  navigator.mediaDevices.getDisplayMedia=async()=>{
    const canvas=document.createElement('canvas'); canvas.width=1280; canvas.height=720;
    const ctx=canvas.getContext('2d');let frame=0;
    const draw=()=>{ctx.fillStyle='#19292f';ctx.fillRect(0,0,1280,720);
      ctx.fillStyle='#68dab3';ctx.fillRect((frame*11)%1150,80,130,250);
      ctx.fillStyle='#fff';ctx.font='70px sans-serif';ctx.fillText(String(frame++),80,540);};
    draw();const timer=setInterval(draw,1000/30),stream=canvas.captureStream(30);
    const video=stream.getVideoTracks()[0],stop=video.stop.bind(video);
    video.stop=()=>{clearInterval(timer);stop();};
    const ac=new AudioContext(),osc=ac.createOscillator(),dest=ac.createMediaStreamDestination();
    osc.frequency.value=440;osc.connect(dest);osc.start();await ac.resume();
    const sound=dest.stream.getAudioTracks()[0],stopSound=sound.stop.bind(sound);let stopped=false;
    sound.stop=()=>{if(stopped)return;stopped=true;osc.stop();void ac.close();stopSound();};
    stream.addTrack(sound);return stream;
  };
  window.networkLab={async sample(){
    const stats=[];
    for(const peer of peers){if(peer.connectionState==='closed')continue;
      const report=await peer.getStats();
      for(const row of report.values()){
        if(row.type==='inbound-rtp'||row.type==='outbound-rtp'||row.type==='remote-inbound-rtp'){
          const selected={type:row.type,kind:row.kind};
          for(const key of ['framesDecoded','framesReceived','framesEncoded','framesDropped','framesPerSecond',
            'frameWidth','frameHeight','bytesReceived','bytesSent','packetsLost','packetsReceived','nackCount',
            'pliCount','totalDecodeTime','jitterBufferDelay','jitterBufferEmittedCount','totalAudioEnergy',
            'totalSamplesDuration','roundTripTime','reportsReceived','qualityLimitationReason','targetBitrate']){
            if(row[key]!==undefined)selected[key]=row[key];
          }stats.push(selected);
        }
        if(row.type==='candidate-pair'&&row.nominated&&row.state==='succeeded'){
          const local=report.get(row.localCandidateId),remote=report.get(row.remoteCandidateId);
          stats.push({type:'selected-pair',rtt:row.currentRoundTripTime,bwe:row.availableOutgoingBitrate,
            localType:local?.candidateType,remoteType:remote?.candidateType,protocol:remote?.protocol,
            localAddress:local?.address,remoteAddress:remote?.address});
        }
      }
    }
    const video=document.querySelector('video');
    return{at:performance.now(),width:video?.videoWidth||0,height:video?.videoHeight||0,
      frames:video?.getVideoPlaybackQuality().totalVideoFrames||0,stats,events:[...events],errors:[...errors],controls:[...controls],
      sharing:!!document.querySelector('button[aria-label="Stop sharing"]'),
      controlOpen:sockets.some(s=>s.url.includes('/control')&&s.readyState===WS.OPEN),
      peerStates:peers.map(p=>p.connectionState),text:document.body.innerText.slice(-2000)};
  }};
})();`;

export interface MediaSample {
  at: number;
  width: number;
  height: number;
  frames: number;
  stats: Array<Record<string, string | number>>;
  events: Array<{ at: number; type: string; state?: string; reason?: string; phase?: string; route?: string }>;
  errors: string[];
  controls: string[];
  sharing: boolean;
  controlOpen: boolean;
  peerStates: string[];
  text: string;
}
