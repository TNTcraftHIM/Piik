// Explicit synthetic experiment. No product media path imports this module.
const settings = new URLSearchParams(location.search);
const mode = settings.get('mode') || 'quiet';
const codec = settings.get('codec') || 'VP8';
const weak = settings.get('weak') === '1';
const network = settings.get('network') === '1';
const split = settings.get('split') === '1';
const noLocalDecode = settings.get('noLocalDecode') === '1';
const derive = settings.get('derive') === '1';
const feedback = settings.get('feedback') === '1';
const late = settings.get('late') === '1';
const automatic = settings.get('automatic') === '1';
const cadenceMs = Number(settings.get('cadenceMs') || 2000);
const high = settings.get('high') === '1';
const noLocalPli = settings.get('noLocalPli') === '1';
const av = settings.get('av') === '1';
const poolWorker = settings.get('poolWorker') === '1';
const single = settings.get('single') === '1';
const product = settings.get('product') === '1';
const nativeSource = settings.get('nativeSource') === '1';
const background = settings.get('background') === '1';
const lifecycle = settings.get('lifecycle') === '1';
const shapedRate = Number(settings.get('rate') || 120000);
const scaledSource = settings.get('scaledSource') === '1';
const visibility = [];
const standard = mode === 'carrier' && !product;
const productPool = product && mode === 'carrier' ? new globalThis.ProbePool() : null;
const productPeers = [], seenProductGroups = new Map();
let rawSource;
let producing = true;
const controls = [];
const productTrace = [];
let productTraceTimer;
const peers = [], tracks = [], encoders = [], monitors = [];
const errors = [], counts = { shared: 0, carrier: 0, dropped: 0, mismatched: 0, keys: 0 };
const sourceTimes = new Map();
const outputs = new Map();
let drawing, budgetTimer, sourceFrame = 0, phase = 'startup';
let audioContext, audioTrack, audioGain;
const audioMonitors = [], sourcePulses = [];
const budgets = [], groupChanges = [];
window.probeProgress = () => ({ phase, sourceFrame, groupChanges, errors,
    pool: productPool ? { members: [...productPool.members].map(m => ({ budget: m.budget, current: m.current?.producer.id, pending: m.pending?.group.producer.id, selecting: m.pending?.requestId, carrier: !!m.carrier, disabled: m.disabled })), groups: [...productPool.groups].map(g => ({ id: g.producer.id, budget: g.budget, output: g.output, ready: g.ready, failed: g.failed })) } : null,
    peers: peers.map(p => ({ connection: p.connectionState, ice: p.iceConnectionState })), audio: audioMonitors.map(m => ({ role: m.role, attached: m.attached, pulses: m.pulses.length })) });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const selectedProfile = () => ({ resolution: high ? '1080p' : '480p', maxFramerate: 30,
    maxBitrate: high ? 5000000 : 1700000, degradationPreference: settings.get('preference') || (high ? 'maintain-resolution' : 'balanced'), screenAudioQuality: 'music' });
function watch(video, role) {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const samples = [];
    let stopped = false;
    const next = () => video.requestVideoFrameCallback((_time, metadata) => {
        if (stopped)
            return;
        if (nativeSource) {
            samples.push({ at: performance.now(), phase, id: metadata.presentedFrames, age: null, width: video.videoWidth, height: video.videoHeight });
            next();
            return;
        }
        try {
            context.drawImage(video, 0, 0, 640, 360);
            const pixels = context.getImageData(0, 0, 640, 30).data;
            let id = 0;
            for (let bit = 0; bit < 12; bit++) {
                const index = (15 * 640 + 20 + bit * 50) * 4;
                if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 384)
                    id |= 1 << bit;
            }
            const now = performance.now(), created = sourceTimes.get(id);
            samples.push({ at: now, phase, id, age: created === undefined ? null : now - created, width: video.videoWidth, height: video.videoHeight });
        }
        catch (error) {
            errors.push(String(error.message));
        }
        next();
    });
    next();
    monitors.push({ role, samples, stop: () => { stopped = true; } });
}
function watchAudio(video, role) {
    // Recapture the element's played audio, rather than the earlier receiver
    // track. This measures element-level A/V, not physical speaker/display lag.
    const played = video.captureStream();
    let attached = false;
    const monitor = { role, pulses: [], attached: false, active: false, stop() { this.active = false; played.getTracks().forEach(t => t.stop()); } };
    audioMonitors.push(monitor);
    const attach = () => {
        if (attached || !played.getAudioTracks().length) return;
        attached = monitor.attached = monitor.active = true;
        const source = audioContext.createMediaStreamSource(played);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        const silent = audioContext.createGain();
        silent.gain.value = 0;
        source.connect(analyser).connect(silent).connect(audioContext.destination);
        const values = new Float32Array(analyser.fftSize);
        let sounded = false;
        const sample = () => {
            if (!monitor.active) { source.disconnect(); analyser.disconnect(); silent.disconnect(); return; }
            analyser.getFloatTimeDomainData(values);
            const loud = values.some(value => Math.abs(value) > .01);
            if (loud && !sounded) monitor.pulses.push({ at: performance.now(), phase });
            sounded = loud;
            requestAnimationFrame(sample);
        };
        sample();
    };
    played.addEventListener('addtrack', attach);
    attach();
}
function workerSource() {
    return `const writers=new Map(), queues=new Map(), carriers=new Map(), writing=new Set(), ordinary=new Set(), seen=new Set();
  const selected=new Map([['A','P'],['B',${late || single ? 'null' : "'P'"}]]), needKey=new Set();
  const counters={shared:0,carrier:0,dropped:0,mismatched:0,keys:0,carrierDrops:0};
  function requestKey(name){self.postMessage({key:selected.get(name)});}
  function drain(name) {
    if(writing.has(name))return;
    const frame=carriers.get(name),queue=queues.get(name);
    if(!frame||!queue?.length)return;
    const shared=queue[0];
    if(frame.type==='key'&&shared.type!=='key') {
      carriers.delete(name);counters.carrierDrops++;counters.mismatched++;
      counters.dropped+=queue.length;queue.length=0;needKey.add(name);requestKey(name);return;
    }
    if(frame.type!=='key'&&shared.type==='key') {
      carriers.delete(name);counters.carrierDrops++;counters.mismatched++;
      self.postMessage({carrierKey:name});return;
    }
    queue.shift();carriers.delete(name);frame.data=shared.data;writing.add(name);
    writers.get(name).write(frame).then(()=>counters.shared++,error=>self.postMessage({error:String(error)}))
      .finally(()=>{writing.delete(name);drain(name);});
  }
  function put(name,frame) {
    const queue=queues.get(name)||[];queues.set(name,queue);
    if(queue.length>=4){counters.dropped+=queue.length;queue.length=0;needKey.add(name);requestKey(name);}
    if(needKey.has(name)&&frame.type!=='key')return;
    if(frame.type==='key'){counters.dropped+=queue.length;queue.length=0;needKey.delete(name);}
    queue.push(frame);drain(name);
  }
  self.onmessage=e=>{
    if(e.data==='snapshot')self.postMessage({counters});
    if(e.data.ordinary){ordinary.add(e.data.ordinary);queues.delete(e.data.ordinary);carriers.delete(e.data.ordinary);}
    if(e.data.share){ordinary.delete(e.data.share);queues.delete(e.data.share);requestKey(e.data.share);}
    if(e.data.select){selected.set(e.data.select.name,e.data.select.source);queues.delete(e.data.select.name);
      carriers.delete(e.data.select.name);needKey.add(e.data.select.name);requestKey(e.data.select.name);}
  };
  self.onrtctransform=e=>{
    const {readable,writable,options}=e.transformer;
    if(options.name.endsWith('-receiver')){readable.pipeTo(new WritableStream({write(){}}));return;}
    const writer=writable.getWriter();writers.set(options.name,writer);
    readable.pipeTo(new WritableStream({async write(frame){
      if(!seen.has(options.name)){seen.add(options.name);self.postMessage({metadata:{name:options.name,setMetadata:typeof frame.setMetadata,...frame.getMetadata()}});}
      if(options.name==='P'||options.name==='L'){
        if(frame.type==='key')counters.keys++;
        for(const name of ['A','B'])if(!ordinary.has(name)&&selected.get(name)===options.name)
          put(name,{data:frame.data.slice(0),type:frame.type});
        await writer.write(frame);return;
      }
      counters.carrier++;
      if(ordinary.has(options.name)){await writer.write(frame);return;}
      if(carriers.has(options.name))counters.carrierDrops++;
      carriers.set(options.name,frame);drain(options.name);
    }})).catch(error=>self.postMessage({error:String(error)}));
  };`;
}
const worker = standard ? poolWorker ? new Worker('/pool-worker.js', { type: 'module' }) : new Worker(URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }))) : null;
worker?.addEventListener('error', event => errors.push(event.message));
let producer;
let pooledOutputs = [];
const transformMetadata = [];
const selections = [];
const currentEdge = role => encoders.findLast(e => e.role === role && e.send.connectionState !== 'closed');
function selectSource(name, source) {
    const requestId = String(performance.now());
    if (!worker) { outputs.get(name)?.select?.(source); return requestId; }
    if (poolWorker) worker.postMessage({ type: 'select', carrierId: currentEdge(name).id, producerId: currentEdge(source).id, requestId });
    else worker.postMessage({ select: { name, source } });
    return requestId;
}
async function retireLower(lower, requestId) {
    if (poolWorker) {
        const deadline = performance.now() + 6000;
        while (!selections.some(s => s.requestId === requestId)) {
            if (performance.now() > deadline) throw Error('Encoding handoff deadline');
            await wait(20);
        }
    }
    lower.finalStats = (await statistics()).L;
    if (poolWorker) worker.postMessage({ type: 'remove', id: lower.id });
    lower.sender.track.stop();
    lower.send.close();
    lower.receive.close();
}
function setParameters(edge, update = () => { }, key = false) {
    edge.parameterTail = (edge.parameterTail || Promise.resolve()).catch(() => {}).then(async () => {
        const parameters = edge.sender.getParameters();
        update(parameters);
        await edge.sender.setParameters(parameters, key ? { encodingOptions: [{ keyFrame: true }] } : {});
    });
    return edge.parameterTail;
}
function requestKey(edge) {
    if (!edge || edge.send.connectionState === 'closed')
        return;
    if (!edge.keyTask)
        edge.keyTask = setParameters(edge, undefined, true)
            .catch(error => errors.push(String(error.message))).finally(() => { edge.keyTask = null; });
}
worker?.addEventListener('message', event => {
    if (event.data.metadata) transformMetadata.push(event.data.metadata);
    if (event.data.type === 'key') requestKey(encoders.find(e => e.id === event.data.id));
    if (event.data.type === 'selected') selections.push({ ...event.data, at: performance.now() });
    if (event.data.type === 'sample') pooledOutputs = event.data.outputs;
    if (event.data.type === 'error') errors.push(event.data.message);
    if (event.data.error)
        errors.push(event.data.error);
    if (event.data.counters)
        Object.assign(counts, event.data.counters);
    if (event.data.key && producer)
        requestKey(encoders.findLast(e => e.role === event.data.key && e.send.connectionState !== 'closed'));
    if (event.data.carrierKey)
        requestKey(encoders.find(e => e.role === event.data.carrierKey));
});
async function connected(pc) {
    const deadline = performance.now() + 6000;
    while (pc.connectionState !== 'connected' && performance.now() < deadline)
        await wait(30);
    if (pc.connectionState !== 'connected')
        throw Error('connection deadline');
}
async function pair(track, role) {
    if (product) return productPair(role);
    const id = role + '-' + encoders.length;
    const initialHint = track.contentHint;
    track.contentHint = 'motion';
    const send = new RTCPeerConnection({ encodedInsertableStreams: !standard && mode !== 'ordinary', iceServers: [] });
    const receive = new RTCPeerConnection({ iceServers: [] });
    peers.push(send, receive);
    if (!(network && role === 'A')) {
        send.onicecandidate = e => { if (e.candidate)
            receive.addIceCandidate(e.candidate).catch(error => errors.push(error.name)); };
        receive.onicecandidate = e => { if (e.candidate)
            send.addIceCandidate(e.candidate).catch(error => errors.push(error.name)); };
    }
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.width = 320;
    if (role === 'A' || role === 'B') document.body.append(video);
    const received = new MediaStream();
    video.srcObject = received;
    receive.ontrack = e => {
        if ((role === 'P' || role === 'L') && noLocalDecode && standard) {
            e.receiver.transform = new RTCRtpScriptTransform(worker, { name: role + '-receiver' });
            return;
        }
        received.addTrack(e.track);
        video.play().catch(() => { });
    };
    const stream = new MediaStream([track]);
    const sender = send.addTrack(track, stream);
    if (audioTrack && (role === 'A' || role === 'B')) {
        stream.addTrack(audioTrack);
        const audioSender = send.addTrack(audioTrack, stream);
        if (!standard && mode !== 'ordinary') {
            const audio = audioSender.createEncodedStreams();
            void audio.readable.pipeTo(audio.writable).catch(error => errors.push(String(error)));
        }
        video.addEventListener('loadeddata', () => watchAudio(video, role), { once: true });
    }
    const codecs = RTCRtpSender.getCapabilities('video').codecs.filter(c => c.mimeType === 'video/' + codec);
    send.getTransceivers()[0].setCodecPreferences(codecs);
    if (standard)
        sender.transform = new RTCRtpScriptTransform(worker, poolWorker ? role === 'A' || role === 'B' ? { id, kind: 'carrier', passthrough: false } : { id, kind: 'producer' } : { name: role });
    const streams = !standard && mode !== 'ordinary' ? sender.createEncodedStreams() : null;
    const entry = { role, id, send, receive, sender, streams, initialHint };
    encoders.push(entry);
    if (streams && role === 'L') produceLegacy(entry);
    if (high)
        await setParameters(entry, p => { p.encodings[0].maxBitrate = 5000000; p.degradationPreference = 'maintain-resolution'; });
    if (scaledSource && (role === 'A' || role === 'B'))
        await setParameters(entry, p => { p.encodings[0].scaleResolutionDownBy = rawSource.getSettings().width / 16; });
    if (role === 'A' || role === 'B')
        watch(video, role);
    return entry;
}
async function productPair(role) {
    const receive = new RTCPeerConnection({ iceServers: [] });
    const pending = [];
    const stream = new MediaStream([rawSource, ...(audioTrack ? [audioTrack] : [])]);
    const profile = selectedProfile();
    let peer;
    peer = new globalThis.ProbeHostPeer(role, { iceServers: [] }, stream, profile, {
        sendSignal(_id, payload) {
            if (payload.kind === 'candidate' && !(network && role === 'A')) {
                if (receive.remoteDescription) receive.addIceCandidate(payload.candidate).catch(error => errors.push(String(error)));
                else pending.push(payload.candidate);
            }
            return true;
        },
        onUpdate(snapshot) { if (snapshot.error) errors.push(snapshot.error); }
    }, { primary: codec.toLowerCase(), vp8Fallback: false }, undefined, false, productPool);
    productPeers.push(peer);
    const video = document.createElement('video'), received = new MediaStream();
    video.autoplay = video.muted = video.playsInline = true;
    video.width = 320;
    video.srcObject = received;
    document.body.append(video);
    receive.ontrack = event => { received.addTrack(event.track); video.play().catch(() => {}); };
    if (av) video.addEventListener('loadeddata', () => watchAudio(video, role), { once: true });
    if (!(network && role === 'A')) receive.onicecandidate = event => {
        if (event.candidate) void peer.acceptSignal({ kind: 'candidate', connectionId: peer.connectionId, candidate: event.candidate.toJSON() });
    };
    // The real HostPeer owns its sender queue, profile application and pool binding.
    if (!await peer.start()) throw Error('Product HostPeer failed to start');
    const entry = { role, id: peer.connectionId, peer, send: peer.connection, receive,
        sender: peer.videoSender, initialHint: rawSource.contentHint, pending };
    encoders.push(entry);
    peers.push(entry.send, receive);
    watch(video, role);
    return entry;
}
async function connect(pair) {
    if (network && pair.role === 'A') {
        const gathered = async (pc) => { const end = performance.now() + 5000; while (pc.iceGatheringState !== 'complete' && performance.now() < end)
            await wait(20); };
        const firstPort = sdp => Number(sdp.match(/^a=candidate:\S+ 1 udp \d+ \S+ (\d+)/mi)?.[1]);
        const proxySDP = (description, port) => ({ ...description, sdp: description.sdp.replace(/^a=candidate:.*\r?\n/gm, '').replace(/^a=mid:[^\r\n]+\r?$/gm, line => line.trimEnd() + '\r\na=candidate:proxy 1 udp 2130706431 127.0.0.1 ' + port + ' typ host\r') });
        const proxy = await fetch('/shaper').then(r => r.json());
        if (!pair.peer) await pair.send.setLocalDescription(await pair.send.createOffer());
        await gathered(pair.send);
        const offer = { type: 'offer', sdp: pair.send.localDescription.sdp };
        if (!offer.sdp.includes('a=end-of-candidates'))
            offer.sdp += 'a=end-of-candidates\r\n';
        await pair.receive.setRemoteDescription(proxySDP(offer, proxy.ports.right));
        await pair.receive.setLocalDescription(await pair.receive.createAnswer());
        await gathered(pair.receive);
        const answer = { type: 'answer', sdp: pair.receive.localDescription.sdp };
        if (!answer.sdp.includes('a=end-of-candidates'))
            answer.sdp += 'a=end-of-candidates\r\n';
        await fetch('/shaper?left=' + firstPort(offer.sdp) + '&right=' + firstPort(answer.sdp));
        const remote = proxySDP(answer, proxy.ports.left);
        if (pair.peer) await pair.peer.acceptSignal({ kind: 'description', connectionId: pair.peer.connectionId, description: remote });
        else await pair.send.setRemoteDescription(remote);
        await connected(pair.send);
        return;
    }
    const offer = pair.peer ? pair.send.localDescription : await pair.send.createOffer();
    if (noLocalPli && (pair.role === 'P' || pair.role === 'L'))
        offer.sdp = offer.sdp.replace(/^a=rtcp-fb:\d+ (?:nack pli|ccm fir)\r?\n/gm, '');
    if (!pair.peer) await pair.send.setLocalDescription(offer);
    await pair.receive.setRemoteDescription(pair.send.localDescription);
    if (pair.pending) for (const candidate of pair.pending.splice(0)) await pair.receive.addIceCandidate(candidate);
    await pair.receive.setLocalDescription(await pair.receive.createAnswer());
    if (pair.peer) await pair.peer.acceptSignal({ kind: 'description', connectionId: pair.peer.connectionId, description: pair.receive.localDescription });
    else await pair.send.setRemoteDescription(pair.receive.localDescription);
    await connected(pair.send);
}
function sink(pair) {
    if (scaledSource && mode === 'live') {
        const writer = pair.streams.writable.getWriter();
        const queue = [];
        let carrier, writing = false, needsKey = true;
        const drain = async () => {
            if (writing || !carrier || !queue.length) return;
            const frame = queue.shift(), own = carrier;
            carrier = null;
            writing = true;
            try {
                const copy = new RTCEncodedVideoFrame(frame, { metadata: { ...frame.getMetadata(), rtpTimestamp: own.timestamp } });
                await writer.write(copy);
            } catch (error) { errors.push(String(error)); }
            finally { writing = false; void drain(); }
        };
        outputs.set(pair.role, { source: 'P', select(source) {
            this.source = source; queue.length = 0; needsKey = true; requestKey(currentEdge(source));
        }, push(frame) {
            if (frame.type === 'key') { queue.length = 0; needsKey = false; }
            if (queue.length >= 4) { queue.length = 0; needsKey = true; requestKey(producer); }
            if (needsKey) return;
            queue.push(new RTCEncodedVideoFrame(frame));
            void drain();
        } });
        pair.streams.readable.pipeTo(new WritableStream({ write(frame) { counts.carrier++; carrier = frame; void drain(); } })).catch(error => errors.push(String(error)));
        return;
    }
    const writer = pair.streams.writable.getWriter();
    const queue = [];
    let busy = false, needKey = true;
    outputs.set(pair.role, { push(frame) {
            if (needKey && frame.type !== 'key')
                return;
            if (frame.type === 'key')
                needKey = false;
            if (queue.length >= 4) {
                counts.dropped += queue.length;
                queue.length = 0;
                needKey = true;
                return;
            }
            queue.push(new RTCEncodedVideoFrame(frame));
            if (!busy)
                void drain();
        } });
    async function drain() { busy = true; try {
        while (queue.length)
            await writer.write(queue.shift());
    }
    catch (error) {
        errors.push(String(error.message));
    }
    finally {
        busy = false;
    } }
    pair.streams.readable.pipeTo(new WritableStream({ write() { counts.carrier++; } })).catch(() => { });
}
function produceLegacy(edge) {
    const writer = edge.streams.writable.getWriter();
    edge.streams.readable.pipeTo(new WritableStream({ async write(frame) {
        if (frame.type === 'key') counts.keys++;
        for (const sink of outputs.values()) if ((sink.source || 'P') === edge.role) { sink.push(frame); counts.shared++; }
        await writer.write(frame);
    } })).catch(error => errors.push(String(error.message)));
}
async function statistics() {
    const result = {};
    for (const edge of encoders) {
        const selectReport = report => Array.from(report.values()).filter(r => ['outbound-rtp', 'inbound-rtp', 'remote-inbound-rtp', 'remote-outbound-rtp', 'candidate-pair', 'transport', 'local-candidate', 'remote-candidate'].includes(r.type)).map(r => {
            const fields = ['type', 'kind', 'id', 'localCandidateId', 'remoteCandidateId', 'selectedCandidatePairId', 'port', 'nominated', 'framesEncoded', 'framesDecoded', 'framesSent', 'framesReceived', 'bytesSent', 'bytesReceived', 'totalEncodeTime', 'totalDecodeTime', 'frameWidth', 'frameHeight', 'framesPerSecond', 'targetBitrate', 'qualityLimitationReason', 'qpSum', 'pliCount', 'nackCount', 'retransmittedBytesSent', 'packetsLost', 'jitter', 'jitterBufferDelay', 'jitterBufferEmittedCount', 'freezeCount', 'totalFreezesDuration', 'reportsSent', 'remoteTimestamp', 'currentRoundTripTime', 'availableOutgoingBitrate', 'state'];
            return Object.fromEntries(fields.filter(k => r[k] !== undefined).map(k => [k, r[k]]));
        });
        const select = async pc => selectReport(await pc.getStats());
        result[edge.role] = edge.finalStats || { send: await select(edge.send), receive: await select(edge.receive) };
        if (edge.peer) {
            const metrics = edge.peer.getSnapshot().metrics;
            result[edge.role].details = Object.fromEntries(['frameWidth', 'frameHeight', 'framesPerSecond', 'bitrateKbps', 'qualityLimitationReason', 'nativeEdgeQualityState', 'intervalFramesSent', 'intervalFramesEncoded'].map(key => [key, metrics[key]]));
        }
        if (productPool && edge.role === 'A') {
            for (const group of productPool.groups) if (!seenProductGroups.has(group.producer.id)) seenProductGroups.set(group.producer.id, { name: 'G' + seenProductGroups.size, group });
            for (const { name, group } of seenProductGroups.values()) {
                const report = await group.producer.report().catch(() => group.report);
                if (report) result[name] = { send: selectReport(report), receive: [], retired: !productPool.groups.has(group) };
            }
        }
    }
    return result;
}
async function snapshot() { return { phase, at: performance.now(), stats: await statistics(), process: await fetch('/process').then(r => r.json()), ...(network ? { shaper: await fetch('/shaper').then(r => r.json()) } : {}) }; }
async function run() {
    if (av) {
        audioContext = new AudioContext({ sampleRate: 48000 });
        await audioContext.resume();
        const destination = audioContext.createMediaStreamDestination();
        const tone = audioContext.createOscillator();
        tone.frequency.value = 1000;
        audioGain = audioContext.createGain();
        audioGain.gain.value = 0;
        tone.connect(audioGain).connect(destination);
        tone.start();
        audioTrack = destination.stream.getAudioTracks()[0];
        tracks.push(audioTrack);
    }
    const source = document.createElement('canvas');
    source.width = high ? 1920 : 640;
    source.height = high ? 1080 : 360;
    if (!nativeSource) document.body.prepend(source);
    const ctx = source.getContext('2d');
    if (high)
        ctx.scale(3, 3);
    const main = nativeSource ? (await navigator.mediaDevices.getUserMedia({ video: { width: source.width, height: source.height, frameRate: 30 }, audio: false })).getVideoTracks()[0] : source.captureStream(0).getVideoTracks()[0];
    rawSource = main;
    main.contentHint = 'motion';
    tracks.push(main);
    if (product) await globalThis.probeApplyProfile(main, selectedProfile());
    const dummies = [];
    for (const role of single ? ['A'] : ['A', 'B']) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 16;
        const track = product ? main : mode === 'ordinary' || scaledSource ? main.clone() : canvas.captureStream(0).getVideoTracks()[0];
        track.contentHint = 'motion';
        tracks.push(track);
        const edge = await pair(track, role);
        dummies.push({ canvas, track });
        if (edge.streams)
            sink(edge);
    }
    if (mode !== 'ordinary' && !product) {
        const track = main.clone();
        tracks.push(track);
        producer = await pair(track, 'P');
        if (producer.streams) {
            produceLegacy(producer);
        }
    }
    if (poolWorker) {
        selectSource('A', 'P');
        if (!late && !single) selectSource('B', 'P');
    }
    for (const edge of encoders)
        if (!late || edge.role !== 'B')
            await connect(edge);
    if (!nativeSource) drawing = setInterval(() => {
        if (!producing) return;
        const id = sourceFrame++ % 4096;
        sourceTimes.set(id, performance.now());
        if (audioGain) {
            audioGain.gain.setValueAtTime(id % 60 < 6 ? .1 : 0, audioContext.currentTime);
            if (id % 60 === 0) sourcePulses.push({ id, at: performance.now() });
        }
        ctx.fillStyle = '#172b3a';
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = '#48c98b';
        ctx.fillRect((sourceFrame * 11) % 540, 65, 100, 220);
        ctx.fillStyle = '#f7b744';
        ctx.font = '40px sans-serif';
        ctx.fillText(String(id), 30, 335);
        for (let bit = 0; bit < 12; bit++) {
            ctx.fillStyle = id & (1 << bit) ? '#fff' : '#000';
            ctx.fillRect(bit * 50, 0, 50, 30);
        }
        rawSource.requestFrame();
        if ((mode === 'live' || standard) && !scaledSource)
            for (const dummy of dummies) {
                const dc = dummy.canvas.getContext('2d');
                dc.fillStyle = '#202020';
                dc.fillRect(0, 0, 16, 16);
                dc.fillStyle = '#606060';
                dc.fillRect(id % 16, Math.floor(id / 16) % 16, 1, 1);
                dummy.track.requestFrame();
            }
    }, 1000 / (lifecycle ? 60 : 30));
    if (mode === 'quiet')
        for (const dummy of dummies)
            dummy.track.requestFrame();
    if (late) {
        await wait(1000);
        await connect(encoders.find(e => e.role === 'B'));
        selectSource('B', 'P');
        if (!product) requestKey(encoders.find(e => e.role === 'B'));
    }
    await wait(400);
    if (standard && !poolWorker) {
        requestKey(encoders.find(e => e.role === 'A'));
        if (!late)
            requestKey(encoders.find(e => e.role === 'B'));
        requestKey(producer);
    }
    await wait(1500);
    if (productPool) {
        const deadline = performance.now() + 12000;
        let activated = null;
        for (;;) {
            const sharing = productPool.members.size === productPeers.length &&
                [...productPool.members].every(m => m.current && m.carrier && !m.replacement) &&
                new Set([...productPool.members].map(m => m.current)).size === 1;
            if (sharing) activated ??= performance.now();
            if (activated !== null && monitors.every(m => {
                const last = m.samples.at(-1);
                return last?.width > 16 && (nativeSource ? last.at >= activated : last.age !== null && (sourceTimes.get(last.id) ?? -1) >= activated);
            })) break;
            if (performance.now() >= deadline) throw Error('Product shared output did not become fresh');
            await wait(30);
        }
    }
    const descriptions = encoders.filter(e => e.role === 'A' || e.role === 'P').map(e => ({ role: e.role,
        extensions: e.send.localDescription?.sdp.match(/^a=extmap:.*$/gm), parameters: e.sender.getParameters().encodings }));
    const snapshots = [await snapshot()];
    if (productPool) productTraceTimer = setInterval(() => productTrace.push({ at: performance.now(), phase,
        members: [...productPool.members].map(m => ({ id: m.id, group: m.current?.producer.id, pending: m.pending?.group.producer.id, selecting: m.pending?.requestId,
            budget: m.budget, mixed: m.mixed, disabled: m.disabled, replaced: !!m.carrier, output: m.output })),
        groups: [...productPool.groups].map(g => ({ id: g.producer.id, budget: g.budget, ready: g.ready, failed: g.failed, output: g.output })) }), 500);
    phase = 'healthy';
    if (automatic && (standard || mode === 'live' && scaledSource)) {
        const edge = encoders.find(e => e.role === 'A');
        let lower = null, updating = false, previous = null;
        budgetTimer = setInterval(async () => {
            if (updating)
                return;
            updating = true;
            try {
                const report = await edge.send.getStats(), sourceReport = await producer.send.getStats();
                const selectedPair = Array.from(report.values()).find(r => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded');
                const sourceStats = Array.from(sourceReport.values()).find(r => r.type === 'outbound-rtp' && r.kind === 'video');
                if (!selectedPair?.availableOutgoingBitrate || !sourceStats)
                    return;
                const now = performance.now();
                const otherBytes = Array.from(report.values()).filter(r => r.type === 'outbound-rtp').reduce((sum, r) => sum + (r.kind === 'audio' ? r.bytesSent || 0 : r.retransmittedBytesSent || 0), 0);
                const otherRate = previous ? Math.max(0, (otherBytes - previous.otherBytes) * 8000 / (now - previous.at)) : 0;
                const carrierStats = Array.from(report.values()).find(r => r.type === 'outbound-rtp' && r.kind === 'video');
                const target = mode === 'live' ? carrierStats.targetBitrate : Math.max(1000, Math.min(high ? 5000000 : 1700000, Math.floor(selectedPair.availableOutgoingBitrate - otherRate)));
                const rate = previous ? (sourceStats.bytesSent - previous.bytes) * 8000 / (now - previous.at) : null;
                previous = { bytes: sourceStats.bytesSent, otherBytes, at: now };
                budgets.push({ at: now, target, available: selectedPair.availableOutgoingBitrate, otherRate, sourceRate: rate });
                if (rate === null)
                    return;
                if (!lower && target < rate) {
                    const track = main.clone();
                    tracks.push(track);
                    lower = await pair(track, 'L');
                    await setParameters(lower, p => { p.encodings[0].maxBitrate = target; });
                    await connect(lower);
                    selectSource('A', 'L');
                    requestKey(edge);
                    groupChanges.push({ at: now, action: 'split', target, sourceRate: rate });
                }
                if (lower) {
                    await setParameters(lower, p => { p.encodings[0].maxBitrate = target; });
                    const stats = Array.from((await lower.send.getStats()).values()).find(r => r.type === 'outbound-rtp' && r.kind === 'video');
                    if (target >= rate && stats?.frameWidth === sourceStats.frameWidth && stats?.frameHeight === sourceStats.frameHeight && stats?.qualityLimitationReason === 'none') {
                        const selected = selectSource('A', 'P');
                        requestKey(edge);
                        await retireLower(lower, selected);
                        lower = null;
                        groupChanges.push({ at: now, action: 'rejoin', target, sourceRate: rate });
                    }
                }
            }
            catch (error) {
                errors.push(String(error.message));
            }
            finally {
                updating = false;
            }
        }, cadenceMs);
    }
    await wait(6000);
    snapshots.push(await snapshot());
    if (lifecycle) {
        let appliedProfile = selectedProfile();
        const apply = async (profile) => {
            const at = performance.now();
            await globalThis.probeApplyProfile(rawSource, profile);
            const applied = await Promise.all(productPeers.map(peer => peer.updateCaptureProfile(profile)));
            controls.push({ phase, profile, elapsedMs: performance.now() - at, applied });
            if (!applied.every(Boolean)) throw Error('Product profile update failed');
            appliedProfile = profile;
        };
        const observe = async (name, duration = 6000) => {
            phase = name;
            await wait(duration);
            snapshots.push(await snapshot());
            if (name.startsWith('quiet-') || name.startsWith('paused-')) return;
            for (const monitor of monitors) {
                const last = monitor.samples.at(-1);
                const ceiling = { '480p': 480, '720p': 720, '1080p': 1080 }[appliedProfile.resolution];
                if (last?.phase !== name || last.age === null || last.age >= 1000 || performance.now() - last.at >= 1000 || last.height > ceiling)
                    throw Error(name + ': receiver did not deliver current frames within the requested ceiling');
            }
        };
        const p60 = { ...selectedProfile(), resolution: '720p', maxFramerate: 60, maxBitrate: 5000000 };
        phase = 'profile-720p60';
        await apply(p60);
        await observe(phase);
        producing = false;
        phase = 'quiet-profile-480p30';
        await apply({ ...p60, resolution: '480p', maxFramerate: 30, maxBitrate: 3000000 });
        await observe(phase, 2500);
        producing = true;
        await observe('resumed-480p30');
        rawSource.enabled = false;
        productPeers.forEach(peer => peer.setPaused(true));
        phase = 'paused-profile-720p30';
        await apply({ ...p60, maxFramerate: 30 });
        await observe(phase, 2000);
        rawSource.enabled = true;
        productPeers.forEach(peer => peer.setPaused(false));
        await observe('resumed-720p30');
        const oldSource = rawSource;
        rawSource = source.captureStream(0).getVideoTracks()[0];
        rawSource.contentHint = 'motion';
        tracks.push(rawSource);
        await globalThis.probeApplyProfile(rawSource, appliedProfile);
        const stream = new MediaStream([rawSource, ...(audioTrack ? [audioTrack] : [])]);
        const replaced = await Promise.all(productPeers.map(peer => peer.replaceStream(stream)));
        controls.push({ action: 'source-replaced', replaced });
        if (!replaced.every(Boolean)) throw Error('Product source replacement failed');
        oldSource.stop();
        await observe('replaced-source');
        if (productPool && [...productPool.groups].some(group => group.source !== rawSource)) throw Error('Old source group survived replacement');
        if (productPool) {
            productPool.worker?.dispatchEvent(new ErrorEvent('error', { message: 'Synthetic worker failure' }));
            await observe('ordinary-after-worker-failure');
            if (productPool.groups.size || productPeers.some(peer => !peer.isConnected())) throw Error('Ordinary recovery did not retire the pool');
        }
    }
    if (background) {
        phase = 'hidden';
        await fetch('/visibility?hidden=1');
        visibility.push({ at: performance.now(), requested: 'hidden', actual: document.visibilityState });
        if (document.visibilityState !== 'hidden') throw Error('Page was not actually hidden');
        await wait(10000);
        snapshots.push(await snapshot());
        phase = 'visible-again';
        await fetch('/visibility?hidden=0');
        visibility.push({ at: performance.now(), requested: 'visible', actual: document.visibilityState });
        if (document.visibilityState !== 'visible') throw Error('Page was not actually restored');
        await wait(6000);
        snapshots.push(await snapshot());
    }
    if (weak) {
        const edge = encoders.find(e => e.role === 'A');
        if (network)
            await fetch('/shaper?rate=' + shapedRate);
        else
            await setParameters(edge, p => { p.encodings[0].maxBitrate = 50000; });
        if (derive && standard) {
            const lowTrack = main.clone();
            tracks.push(lowTrack);
            const lower = await pair(lowTrack, 'L');
            await setParameters(lower, p => { p.encodings[0].maxBitrate = network ? 80000 : 40000; });
            await connect(lower);
            selectSource('A', 'L');
            await setParameters(edge, undefined, true);
            if (feedback) {
                let updating = false;
                budgetTimer = setInterval(async () => {
                    if (updating)
                        return;
                    updating = true;
                    try {
                        const report = await edge.send.getStats();
                        const pair = Array.from(report.values()).find(r => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded');
                        if (Number.isFinite(pair?.availableOutgoingBitrate)) {
                            const target = Math.max(1000, Math.min(1700000, Math.floor(pair.availableOutgoingBitrate)));
                            await setParameters(lower, p => { p.encodings[0].maxBitrate = target; });
                            budgets.push({ at: performance.now(), target });
                        }
                    }
                    catch (error) {
                        errors.push(String(error.message));
                    }
                    finally {
                        updating = false;
                    }
                }, 2000);
            }
        }
        if (split && standard) {
            worker.postMessage({ ordinary: 'A' });
            const independent = main.clone();
            tracks.push(independent);
            await edge.sender.replaceTrack(independent);
            await setParameters(edge, undefined, true);
        }
        phase = 'limited';
        await wait(14000);
        snapshots.push(await snapshot());
        if (network)
            await fetch('/shaper?rate=0');
        else
            await setParameters(edge, p => { delete p.encodings[0].maxBitrate; });
        if (derive && standard && !feedback) {
            const selected = selectSource('A', 'P');
            await setParameters(edge, undefined, true);
            const lower = encoders.find(e => e.role === 'L');
            await retireLower(lower, selected);
        }
        if (split && standard) {
            await edge.sender.replaceTrack(dummies[0].track);
            worker.postMessage({ share: 'A' });
            await setParameters(edge, undefined, true);
        }
        phase = 'released';
        await wait(feedback || automatic ? 40000 : 10000);
        snapshots.push(await snapshot());
    }
    worker?.postMessage(poolWorker ? { type: 'sample', requestId: 'final' } : 'snapshot');
    await wait(30);
    return { mode, codec, weak, network, split, noLocalDecode, noLocalPli, derive, feedback, late, automatic, cadenceMs, av, high, poolWorker, pooledOutputs, selections, budgets, groupChanges, descriptions, inputHints: encoders.map(e => ({ role: e.role, initial: e.initialHint, applied: e.sender.track?.contentHint })), browser: navigator.userAgent, snapshots, counts: poolWorker ? null : counts, sourcePulses, audioMonitors: audioMonitors.map(({ role, pulses, attached }) => ({ role, pulses, attached })), monitors: monitors.map(({ role, samples }) => ({ role, samples })), errors };
}
try {
    const result = await run();
    window.probeResult = { ...result, counts: product ? null : result.counts, transformMetadata, single, product, scaledSource, profile: selectedProfile(), background, nativeSource, lifecycle, shapedRate, controls, visibility, productTrace };
}
catch (error) {
    window.probeResult = { mode, codec, error: String(error?.stack || error?.message || error), progress: window.probeProgress(), errors };
}
finally {
    clearInterval(drawing);
    clearInterval(budgetTimer);
    clearInterval(productTraceTimer);
    monitors.forEach(m => m.stop());
    audioMonitors.forEach(m => m.stop());
    productPeers.forEach(peer => peer.dispose());
    productPool?.dispose();
    tracks.forEach(t => t.stop());
    peers.forEach(pc => pc.close());
    await audioContext?.close();
    worker?.terminate();
    window.probeDone = true;
}
