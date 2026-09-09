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
const high = settings.get('high') === '1';
const noLocalPli = settings.get('noLocalPli') === '1';
const standard = mode === 'carrier';
const peers = [], tracks = [], encoders = [], monitors = [];
const errors = [], counts = { shared: 0, carrier: 0, dropped: 0, mismatched: 0, keys: 0 };
const sourceTimes = new Map();
const outputs = new Map();
let drawing, budgetTimer, sourceFrame = 0, phase = 'startup';
const budgets = [], groupChanges = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function watch(video, role) {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const samples = [];
    let stopped = false;
    const next = () => video.requestVideoFrameCallback(() => {
        if (stopped)
            return;
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
function workerSource() {
    return `const writers=new Map(), queues=new Map(), carriers=new Map(), writing=new Set(), ordinary=new Set();
  const selected=new Map([['A','P'],['B',${late ? 'null' : "'P'"}]]), needKey=new Set();
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
const worker = standard ? new Worker(URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }))) : null;
worker?.addEventListener('error', event => errors.push(event.message));
let producer;
function setParameters(edge, update = () => { }, key = false) {
    edge.parameterTail = (edge.parameterTail || Promise.resolve()).then(async () => {
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
    if (event.data.error)
        errors.push(event.data.error);
    if (event.data.counters)
        Object.assign(counts, event.data.counters);
    if (event.data.key && producer)
        requestKey(encoders.find(e => e.role === event.data.key) || producer);
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
    document.body.append(video);
    receive.ontrack = e => {
        if ((role === 'P' || role === 'L') && noLocalDecode && standard) {
            e.receiver.transform = new RTCRtpScriptTransform(worker, { name: role + '-receiver' });
            return;
        }
        video.srcObject = new MediaStream([e.track]);
        video.play().catch(() => { });
    };
    const sender = send.addTrack(track, new MediaStream([track]));
    const codecs = RTCRtpSender.getCapabilities('video').codecs.filter(c => c.mimeType === 'video/' + codec);
    send.getTransceivers()[0].setCodecPreferences(codecs);
    if (standard)
        sender.transform = new RTCRtpScriptTransform(worker, { name: role });
    const streams = !standard && mode !== 'ordinary' ? sender.createEncodedStreams() : null;
    const entry = { role, send, receive, sender, streams };
    encoders.push(entry);
    if (high)
        await setParameters(entry, p => { p.encodings[0].maxBitrate = 5000000; p.degradationPreference = 'maintain-resolution'; });
    if (role === 'A' || role === 'B')
        watch(video, role);
    return entry;
}
async function connect(pair) {
    if (network && pair.role === 'A') {
        const gathered = async (pc) => { const end = performance.now() + 5000; while (pc.iceGatheringState !== 'complete' && performance.now() < end)
            await wait(20); };
        const firstPort = sdp => Number(sdp.match(/^a=candidate:\S+ 1 udp \d+ \S+ (\d+)/mi)?.[1]);
        const proxySDP = (description, port) => ({ ...description, sdp: description.sdp.replace(/^a=candidate:.*\r?\n/gm, '').replace('a=end-of-candidates', 'a=candidate:proxy 1 udp 2130706431 127.0.0.1 ' + port + ' typ host\r\na=end-of-candidates') });
        const proxy = await fetch('/shaper').then(r => r.json());
        await pair.send.setLocalDescription(await pair.send.createOffer());
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
        await pair.send.setRemoteDescription(proxySDP(answer, proxy.ports.left));
        await connected(pair.send);
        return;
    }
    const offer = await pair.send.createOffer();
    if (noLocalPli && (pair.role === 'P' || pair.role === 'L'))
        offer.sdp = offer.sdp.replace(/^a=rtcp-fb:\d+ (?:nack pli|ccm fir)\r?\n/gm, '');
    await pair.send.setLocalDescription(offer);
    await pair.receive.setRemoteDescription(pair.send.localDescription);
    await pair.receive.setLocalDescription(await pair.receive.createAnswer());
    await pair.send.setRemoteDescription(pair.receive.localDescription);
    await connected(pair.send);
}
function sink(pair) {
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
async function statistics() {
    const result = {};
    for (const edge of encoders) {
        const select = async (pc) => Array.from((await pc.getStats()).values()).filter(r => ['outbound-rtp', 'inbound-rtp', 'remote-inbound-rtp', 'remote-outbound-rtp', 'candidate-pair', 'transport', 'local-candidate', 'remote-candidate'].includes(r.type)).map(r => {
            const fields = ['type', 'kind', 'id', 'localCandidateId', 'remoteCandidateId', 'selectedCandidatePairId', 'port', 'nominated', 'framesEncoded', 'framesDecoded', 'framesSent', 'framesReceived', 'bytesSent', 'bytesReceived', 'totalEncodeTime', 'totalDecodeTime', 'frameWidth', 'frameHeight', 'framesPerSecond', 'targetBitrate', 'qualityLimitationReason', 'pliCount', 'nackCount', 'retransmittedBytesSent', 'packetsLost', 'jitter', 'jitterBufferDelay', 'jitterBufferEmittedCount', 'freezeCount', 'totalFreezesDuration', 'reportsSent', 'remoteTimestamp', 'currentRoundTripTime', 'availableOutgoingBitrate', 'state'];
            return Object.fromEntries(fields.filter(k => r[k] !== undefined).map(k => [k, r[k]]));
        });
        result[edge.role] = edge.finalStats || { send: await select(edge.send), receive: await select(edge.receive) };
    }
    return result;
}
async function snapshot() { return { phase, at: performance.now(), stats: await statistics(), process: await fetch('/process').then(r => r.json()), ...(network ? { shaper: await fetch('/shaper').then(r => r.json()) } : {}) }; }
async function run() {
    const source = document.createElement('canvas');
    source.width = high ? 1920 : 640;
    source.height = high ? 1080 : 360;
    document.body.prepend(source);
    const ctx = source.getContext('2d');
    if (high)
        ctx.scale(3, 3);
    const main = source.captureStream(0).getVideoTracks()[0];
    main.contentHint = 'motion';
    tracks.push(main);
    const dummies = [];
    for (const role of ['A', 'B']) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 16;
        const track = mode === 'ordinary' ? main.clone() : canvas.captureStream(0).getVideoTracks()[0];
        track.contentHint = 'motion';
        tracks.push(track);
        const edge = await pair(track, role);
        dummies.push({ canvas, track });
        if (edge.streams)
            sink(edge);
    }
    if (mode !== 'ordinary') {
        const track = main.clone();
        tracks.push(track);
        producer = await pair(track, 'P');
        if (producer.streams) {
            const writer = producer.streams.writable.getWriter();
            producer.streams.readable.pipeTo(new WritableStream({ async write(frame) {
                    if (frame.type === 'key')
                        counts.keys++;
                    for (const sink of outputs.values()) {
                        sink.push(frame);
                        counts.shared++;
                    }
                    await writer.write(frame);
                } })).catch(error => errors.push(String(error.message)));
        }
    }
    for (const edge of encoders)
        if (!late || edge.role !== 'B')
            await connect(edge);
    drawing = setInterval(() => {
        const id = sourceFrame++ % 4096;
        sourceTimes.set(id, performance.now());
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
        main.requestFrame();
        if (mode === 'live' || standard)
            for (const dummy of dummies) {
                const dc = dummy.canvas.getContext('2d');
                dc.fillStyle = '#202020';
                dc.fillRect(0, 0, 16, 16);
                dc.fillStyle = '#606060';
                dc.fillRect(id % 16, Math.floor(id / 16) % 16, 1, 1);
                dummy.track.requestFrame();
            }
    }, 1000 / 30);
    if (mode === 'quiet')
        for (const dummy of dummies)
            dummy.track.requestFrame();
    if (late) {
        await wait(1000);
        await connect(encoders.find(e => e.role === 'B'));
        worker?.postMessage({ select: { name: 'B', source: 'P' } });
        requestKey(encoders.find(e => e.role === 'B'));
    }
    await wait(400);
    if (standard) {
        requestKey(encoders.find(e => e.role === 'A'));
        if (!late)
            requestKey(encoders.find(e => e.role === 'B'));
        requestKey(producer);
    }
    await wait(1500);
    const snapshots = [await snapshot()];
    phase = 'healthy';
    await wait(6000);
    snapshots.push(await snapshot());
    if (automatic && standard) {
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
                const now = performance.now(), target = Math.max(1000, Math.min(high ? 5000000 : 1700000, Math.floor(selectedPair.availableOutgoingBitrate)));
                const rate = previous ? (sourceStats.bytesSent - previous.bytes) * 8000 / (now - previous.at) : null;
                previous = { bytes: sourceStats.bytesSent, at: now };
                budgets.push({ at: now, target, sourceRate: rate });
                if (rate === null)
                    return;
                if (!lower && target < rate) {
                    const track = main.clone();
                    tracks.push(track);
                    lower = await pair(track, 'L');
                    await setParameters(lower, p => { p.encodings[0].maxBitrate = target; });
                    await connect(lower);
                    worker.postMessage({ select: { name: 'A', source: 'L' } });
                    requestKey(edge);
                    groupChanges.push({ at: now, action: 'split', target, sourceRate: rate });
                }
                if (lower) {
                    await setParameters(lower, p => { p.encodings[0].maxBitrate = target; });
                    const stats = Array.from((await lower.send.getStats()).values()).find(r => r.type === 'outbound-rtp' && r.kind === 'video');
                    if (target >= rate && stats?.frameWidth === sourceStats.frameWidth && stats?.frameHeight === sourceStats.frameHeight && stats?.qualityLimitationReason === 'none') {
                        worker.postMessage({ select: { name: 'A', source: 'P' } });
                        requestKey(edge);
                        lower.finalStats = (await statistics()).L;
                        lower.sender.track.stop();
                        lower.send.close();
                        lower.receive.close();
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
        }, 2000);
    }
    if (weak) {
        const edge = encoders.find(e => e.role === 'A');
        if (network)
            await fetch('/shaper?rate=120000');
        else
            await setParameters(edge, p => { p.encodings[0].maxBitrate = 50000; });
        if (derive && standard) {
            const lowTrack = main.clone();
            tracks.push(lowTrack);
            const lower = await pair(lowTrack, 'L');
            await setParameters(lower, p => { p.encodings[0].maxBitrate = network ? 80000 : 40000; });
            await connect(lower);
            worker.postMessage({ select: { name: 'A', source: 'L' } });
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
            worker.postMessage({ select: { name: 'A', source: 'P' } });
            await setParameters(edge, undefined, true);
            const lower = encoders.find(e => e.role === 'L');
            lower.finalStats = (await statistics()).L;
            lower.sender.track.stop();
            lower.send.close();
            lower.receive.close();
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
    worker?.postMessage('snapshot');
    await wait(30);
    return { mode, codec, weak, network, split, noLocalDecode, noLocalPli, derive, feedback, late, automatic, high, budgets, groupChanges, browser: navigator.userAgent, snapshots, counts, monitors: monitors.map(({ role, samples }) => ({ role, samples })), errors };
}
try {
    window.probeResult = await run();
}
catch (error) {
    window.probeResult = { mode, codec, error: String(error.stack), errors };
}
finally {
    clearInterval(drawing);
    clearInterval(budgetTimer);
    monitors.forEach(m => m.stop());
    tracks.forEach(t => t.stop());
    peers.forEach(pc => pc.close());
    worker?.terminate();
    window.probeDone = true;
}
