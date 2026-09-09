// Actual HostPeer/BrowserEncodingPool comparison; synthetic source and local receivers only.
import { BrowserEncodingPool as ProbePool } from '../src/client/media/browser-encoding-pool';
import { HostPeer as ProbeHostPeer } from '../src/client/webrtc/host-peer';
import { applyVideoCaptureProfile as probeApplyProfile } from '../src/client/media/quality';
import { browserDebugEnabled, exportBrowserDebug } from '../src/client/lib/debug';

const settings = new URLSearchParams(location.search);
const mode = settings.get('mode') || 'carrier', codec = settings.get('codec') || 'VP8';
const network = settings.get('network') === '1', automatic = settings.get('automatic') === '1';
const high = settings.get('high') === '1', av = settings.get('av') === '1';
const single = settings.get('single') === '1', late = settings.get('late') === '1';
const nativeSource = settings.get('nativeSource') === '1', background = settings.get('background') === '1';
const lifecycle = settings.get('lifecycle') === '1', shapedRate = Number(settings.get('rate') || 120000);
const relay = settings.get('relay') === '1';
const selectedProfile = () => ({ resolution: high ? '1080p' : '480p', maxFramerate: 30,
    maxBitrate: high ? 5000000 : 1700000,
    degradationPreference: settings.get('preference') || (high ? 'maintain-resolution' : 'balanced'),
    screenAudioQuality: 'music' });
const productPool = mode === 'carrier' ? new ProbePool() : null;
const productPeers = [], peers = [], tracks = [], edges = [], monitors = [], audioMonitors = [];
const errors = [], sourcePulses = [], controls = [], visibility = [], productTrace = [];
const sourceTimes = new Map(), seenProductGroups = new Map();
let rawSource, drawing, productTraceTimer, audioContext, audioTrack, audioGain, upstreamPeer;
let producing = true, sourceFrame = 0, phase = 'startup';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const poolState = () => productPool ? {
    members: [...productPool.members].map(m => ({ id: m.id, group: m.current?.producer.id,
        pending: m.pending?.group.producer.id, selecting: m.pending?.selecting, budget: m.budget,
        mixed: m.mixed, disabled: m.disabled, carrier: m.carrier, replacing: !!m.replacement,
        output: m.output, queued: m.encoded.current?.frames.length,
        waitingKey: m.encoded.current?.needKey, pendingFrames: m.encoded.pending?.queue.frames.length })),
    groups: [...productPool.groups].map(g => ({ id: g.producer.id, budget: g.budget,
        ready: g.ready, failed: g.failed, output: g.output }))
} : null;
window.probeProgress = () => ({ phase, sourceFrame, errors, pool: poolState(),
    peers: peers.map(p => ({ connection: p.connectionState, ice: p.iceConnectionState })),
    audio: audioMonitors.map(m => ({ role: m.role, attached: m.attached, pulses: m.pulses.length })) });

function watch(video, role) {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext('2d', { willReadFrequently: true }), samples = [];
    let stopped = false;
    const next = () => video.requestVideoFrameCallback((_time, metadata) => {
        if (stopped) return;
        if (nativeSource) {
            samples.push({ at: performance.now(), phase, id: metadata.presentedFrames, age: null,
                width: video.videoWidth, height: video.videoHeight });
        } else {
            try {
                context.drawImage(video, 0, 0, 640, 360);
                const pixels = context.getImageData(0, 0, 640, 30).data;
                let id = 0;
                for (let bit = 0; bit < 12; bit++) {
                    const index = (15 * 640 + 20 + bit * 50) * 4;
                    if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 384) id |= 1 << bit;
                }
                const now = performance.now(), created = sourceTimes.get(id);
                samples.push({ at: now, phase, id, age: created === undefined ? null : now - created,
                    width: video.videoWidth, height: video.videoHeight });
            } catch (error) { errors.push(String(error.message)); }
        }
        next();
    });
    next();
    monitors.push({ role, samples, stop: () => { stopped = true; } });
}

function watchAudio(video, role) {
    // Observe element-level played audio, not the earlier receiver track or physical speakers.
    const played = video.captureStream();
    const monitor = { role, pulses: [], attached: false, active: false,
        stop() { this.active = false; played.getTracks().forEach(t => t.stop()); } };
    audioMonitors.push(monitor);
    const attach = () => {
        if (monitor.attached || !played.getAudioTracks().length) return;
        monitor.attached = monitor.active = true;
        const source = audioContext.createMediaStreamSource(played), analyser = audioContext.createAnalyser();
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

async function pair(role) {
    const receive = new RTCPeerConnection({ iceServers: [] }), pending = [];
    peers.push(receive);
    const stream = new MediaStream([rawSource, ...(audioTrack ? [audioTrack] : [])]);
    let peer;
    peer = new ProbeHostPeer(role, { iceServers: [] }, stream, selectedProfile(), {
        sendSignal(_id, payload) {
            if (payload.kind === 'candidate' && !(network && role === 'A')) {
                if (receive.remoteDescription) receive.addIceCandidate(payload.candidate).catch(error => errors.push(String(error)));
                else pending.push(payload.candidate);
            }
            return true;
        },
        onUpdate(snapshot) { if (snapshot.error) errors.push(snapshot.error); }
    }, { primary: codec.toLowerCase(), vp8Fallback: false }, undefined, false, role === 'U' ? null : productPool);
    if (role === 'U') upstreamPeer = peer;
    else productPeers.push(peer);
    peers.push(peer.connection);
    const video = document.createElement('video'), received = new MediaStream();
    video.autoplay = video.muted = video.playsInline = true;
    video.width = 320; video.srcObject = received;
    if (role !== 'U') document.body.append(video);
    receive.ontrack = event => { received.addTrack(event.track); video.play().catch(() => {}); };
    if (av && role !== 'U') video.addEventListener('loadeddata', () => watchAudio(video, role), { once: true });
    if (!(network && role === 'A')) receive.onicecandidate = event => {
        if (event.candidate) void peer.acceptSignal({ kind: 'candidate',
            connectionId: peer.connectionId, candidate: event.candidate.toJSON() });
    };
    if (!await peer.start()) throw Error('Product HostPeer failed to start');
    const edge = { role, peer, send: peer.connection, receive, sender: peer.videoSender, pending, received };
    edges.push(edge);
    if (role !== 'U') watch(video, role);
    return edge;
}

async function connect(edge) {
    if (network && edge.role === 'A') {
        const gathered = async pc => {
            const end = performance.now() + 5000;
            while (pc.iceGatheringState !== 'complete' && performance.now() < end) await wait(20);
        };
        const firstPort = sdp => Number(sdp.match(/^a=candidate:\S+ 1 udp \d+ \S+ (\d+)/mi)?.[1]);
        const proxySDP = (description, port) => ({ ...description, sdp: description.sdp.replace(/^a=candidate:.*\r?\n/gm, '')
            .replace(/^a=mid:[^\r\n]+\r?$/gm, line => line.trimEnd() + '\r\na=candidate:proxy 1 udp 2130706431 127.0.0.1 ' + port + ' typ host\r') });
        const proxy = await fetch('/shaper').then(r => r.json());
        await gathered(edge.send);
        const offer = { type: 'offer', sdp: edge.send.localDescription.sdp };
        if (!offer.sdp.includes('a=end-of-candidates')) offer.sdp += 'a=end-of-candidates\r\n';
        await edge.receive.setRemoteDescription(proxySDP(offer, proxy.ports.right));
        await edge.receive.setLocalDescription(await edge.receive.createAnswer());
        await gathered(edge.receive);
        const answer = { type: 'answer', sdp: edge.receive.localDescription.sdp };
        if (!answer.sdp.includes('a=end-of-candidates')) answer.sdp += 'a=end-of-candidates\r\n';
        await fetch('/shaper?left=' + firstPort(offer.sdp) + '&right=' + firstPort(answer.sdp));
        await edge.peer.acceptSignal({ kind: 'description', connectionId: edge.peer.connectionId,
            description: proxySDP(answer, proxy.ports.left) });
    } else {
        await edge.receive.setRemoteDescription(edge.send.localDescription);
        for (const candidate of edge.pending.splice(0)) await edge.receive.addIceCandidate(candidate);
        await edge.receive.setLocalDescription(await edge.receive.createAnswer());
        await edge.peer.acceptSignal({ kind: 'description', connectionId: edge.peer.connectionId,
            description: edge.receive.localDescription });
    }
    const deadline = performance.now() + 6000;
    while (edge.send.connectionState !== 'connected' && performance.now() < deadline) await wait(30);
    if (edge.send.connectionState !== 'connected') throw Error('Connection deadline');
}

const selectReport = report => Array.from(report.values())
    .filter(r => ['outbound-rtp', 'inbound-rtp', 'remote-inbound-rtp', 'remote-outbound-rtp',
        'candidate-pair', 'transport', 'local-candidate', 'remote-candidate'].includes(r.type))
    .map(r => {
        const fields = ['type', 'kind', 'id', 'localCandidateId', 'remoteCandidateId', 'selectedCandidatePairId',
            'port', 'nominated', 'framesEncoded', 'framesDecoded', 'framesSent', 'framesReceived', 'bytesSent',
            'bytesReceived', 'totalEncodeTime', 'totalDecodeTime', 'frameWidth', 'frameHeight', 'framesPerSecond',
            'targetBitrate', 'qualityLimitationReason', 'qpSum', 'pliCount', 'nackCount', 'retransmittedBytesSent',
            'packetsLost', 'jitter', 'jitterBufferDelay', 'jitterBufferEmittedCount', 'freezeCount',
            'totalFreezesDuration', 'reportsSent', 'remoteTimestamp', 'currentRoundTripTime', 'availableOutgoingBitrate', 'state'];
        return Object.fromEntries(fields.filter(key => r[key] !== undefined).map(key => [key, r[key]]));
    });
async function statistics() {
    const result = {};
    for (const edge of edges) {
        const metrics = edge.peer.getSnapshot().metrics;
        result[edge.role] = { send: selectReport(await edge.send.getStats()),
            receive: selectReport(await edge.receive.getStats()),
            details: Object.fromEntries(['frameWidth', 'frameHeight', 'framesPerSecond', 'bitrateKbps',
                'qualityLimitationReason', 'nativeEdgeQualityState', 'intervalFramesSent', 'intervalFramesEncoded']
                .map(key => [key, metrics[key]])) };
    }
    if (productPool) {
        for (const group of productPool.groups) if (!seenProductGroups.has(group.producer.id))
            seenProductGroups.set(group.producer.id, { name: 'G' + seenProductGroups.size, group });
        for (const entry of seenProductGroups.values()) {
            const { name, group } = entry;
            const report = await group.producer.report().catch(() => entry.report ?? group.report);
            if (report) {
                entry.report = report;
                result[name] = { send: selectReport(report), receive: [], retired: !productPool.groups.has(group) };
            }
        }
    }
    return result;
}
async function snapshot() {
    return { phase, at: performance.now(), stats: await statistics(),
        process: await fetch('/process').then(r => r.json()),
        ...(network ? { shaper: await fetch('/shaper').then(r => r.json()) } : {}) };
}

async function run() {
    if (av) {
        audioContext = new AudioContext({ sampleRate: 48000 });
        await audioContext.resume();
        const destination = audioContext.createMediaStreamDestination(), tone = audioContext.createOscillator();
        tone.frequency.value = 1000;
        audioGain = audioContext.createGain(); audioGain.gain.value = 0;
        tone.connect(audioGain).connect(destination); tone.start();
        audioTrack = destination.stream.getAudioTracks()[0]; tracks.push(audioTrack);
    }
    const source = document.createElement('canvas');
    source.width = high ? 1920 : 640; source.height = high ? 1080 : 360;
    if (!nativeSource) document.body.prepend(source);
    const ctx = source.getContext('2d');
    if (high) ctx.scale(3, 3);
    rawSource = nativeSource ? (await navigator.mediaDevices.getUserMedia({
        video: { width: source.width, height: source.height, frameRate: 30 }, audio: false
    })).getVideoTracks()[0] : source.captureStream(0).getVideoTracks()[0];
    rawSource.contentHint = 'motion'; tracks.push(rawSource);
    await probeApplyProfile(rawSource, selectedProfile());
    const main = rawSource;
    const connectChildren = async () => {
        for (const role of single ? ['A'] : ['A', 'B']) await pair(role);
        for (const edge of edges) if (edge.role !== 'U' && (!late || edge.role !== 'B')) await connect(edge);
    };
    if (!relay) await connectChildren();
    if (!nativeSource) drawing = setInterval(() => {
        if (!producing) return;
        const id = sourceFrame++ % 4096;
        sourceTimes.set(id, performance.now());
        if (audioGain) {
            audioGain.gain.setValueAtTime(id % 60 < 6 ? .1 : 0, audioContext.currentTime);
            if (id % 60 === 0) sourcePulses.push({ id, at: performance.now() });
        }
        ctx.fillStyle = '#172b3a'; ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = '#48c98b'; ctx.fillRect((sourceFrame * 11) % 540, 65, 100, 220);
        ctx.fillStyle = '#f7b744'; ctx.font = '40px sans-serif'; ctx.fillText(String(id), 30, 335);
        for (let bit = 0; bit < 12; bit++) {
            ctx.fillStyle = id & (1 << bit) ? '#fff' : '#000'; ctx.fillRect(bit * 50, 0, 50, 30);
        }
        (relay ? main : rawSource).requestFrame();
    }, 1000 / (lifecycle ? 60 : 30));
    if (productPool) productTraceTimer = setInterval(() => productTrace.push({ at: performance.now(), phase, ...poolState() }), 500);
    if (relay) {
        const upstream = await pair('U');
        await connect(upstream);
        rawSource = upstream.received.getVideoTracks()[0];
        audioTrack = upstream.received.getAudioTracks()[0];
        if (!rawSource || av && !audioTrack) throw Error('Relay upstream did not supply its tracks');
        rawSource.contentHint = 'motion';
        await connectChildren();
    }
    if (late) { await wait(1000); await connect(edges.find(e => e.role === 'B')); }
    await wait(1900);
    if (productPool) {
        const deadline = performance.now() + 12000;
        let activated = null;
        for (;;) {
            const members = [...productPool.members];
            const sharing = members.length === productPeers.length && members.every(m => m.current && m.carrier && !m.replacement) &&
                new Set(members.map(m => m.current)).size === 1;
            if (sharing) activated ??= performance.now();
            else activated = null;
            if (activated !== null && monitors.every(m => {
                const last = m.samples.at(-1);
                return last?.width > 16 && (nativeSource ? last.at >= activated :
                    last.age !== null && (sourceTimes.get(last.id) ?? -1) >= activated);
            })) break;
            if (performance.now() >= deadline) throw Error('Product shared output did not become fresh');
            await wait(30);
        }
    }
    const descriptions = edges.map(e => ({ role: e.role,
        extensions: e.send.localDescription?.sdp.match(/^a=extmap:.*$/gm),
        parameters: e.sender.getParameters().encodings }));
    const snapshots = [await snapshot()];
    phase = 'healthy'; await wait(6000); snapshots.push(await snapshot());
    if (lifecycle) {
        let appliedProfile = selectedProfile();
        const apply = async profile => {
            const at = performance.now();
            await probeApplyProfile(rawSource, profile);
            const applied = await Promise.all(productPeers.map(peer => peer.updateCaptureProfile(profile)));
            controls.push({ phase, profile, elapsedMs: performance.now() - at, applied });
            if (!applied.every(Boolean)) throw Error('Product profile update failed');
            appliedProfile = profile;
        };
        const observe = async (name, duration = 6000) => {
            phase = name; await wait(duration); snapshots.push(await snapshot());
            if (name.startsWith('quiet-') || name.startsWith('paused-')) return;
            for (const monitor of monitors) {
                const last = monitor.samples.at(-1), ceiling = { '480p': 480, '720p': 720, '1080p': 1080 }[appliedProfile.resolution];
                if (last?.phase !== name || last.age === null || last.age >= 1000 ||
                    performance.now() - last.at >= 1000 || last.height > ceiling)
                    throw Error(name + ': receiver did not deliver current frames within the requested ceiling');
            }
        };
        const p60 = { ...selectedProfile(), resolution: '720p', maxFramerate: 60, maxBitrate: 5000000 };
        phase = 'profile-720p60'; await apply(p60); await observe(phase);
        producing = false; phase = 'quiet-profile-480p30';
        await apply({ ...p60, resolution: '480p', maxFramerate: 30, maxBitrate: 3000000 });
        await observe(phase, 2500);
        producing = true; await observe('resumed-480p30');
        rawSource.enabled = false; productPeers.forEach(peer => peer.setPaused(true));
        phase = 'paused-profile-720p30'; await apply({ ...p60, maxFramerate: 30 }); await observe(phase, 2000);
        rawSource.enabled = true; productPeers.forEach(peer => peer.setPaused(false));
        await observe('resumed-720p30');
        const oldSource = rawSource;
        rawSource = source.captureStream(0).getVideoTracks()[0];
        rawSource.contentHint = 'motion'; tracks.push(rawSource);
        await probeApplyProfile(rawSource, appliedProfile);
        const stream = new MediaStream([rawSource, ...(audioTrack ? [audioTrack] : [])]);
        const replaced = await Promise.all(productPeers.map(peer => peer.replaceStream(stream)));
        controls.push({ action: 'source-replaced', replaced });
        if (!replaced.every(Boolean)) throw Error('Product source replacement failed');
        oldSource.stop(); await observe('replaced-source');
        if (productPool && [...productPool.groups].some(group => group.source !== rawSource)) throw Error('Old source group survived replacement');
        if (productPool) {
            for (const group of [...productPool.groups]) group.producer.fail();
            await observe('ordinary-after-producer-failure');
            if (productPool.groups.size || productPeers.some(peer => !peer.isConnected())) throw Error('Ordinary recovery did not retire the pool');
        }
    }
    if (background) {
        phase = 'hidden'; await fetch('/visibility?hidden=1');
        visibility.push({ at: performance.now(), requested: 'hidden', actual: document.visibilityState });
        if (document.visibilityState !== 'hidden') throw Error('Page was not actually hidden');
        await wait(10000); snapshots.push(await snapshot());
        phase = 'visible-again'; await fetch('/visibility?hidden=0');
        visibility.push({ at: performance.now(), requested: 'visible', actual: document.visibilityState });
        if (document.visibilityState !== 'visible') throw Error('Page was not actually restored');
        await wait(6000); snapshots.push(await snapshot());
    }
    if (network) {
        await fetch('/shaper?rate=' + shapedRate);
        phase = 'limited'; await wait(14000); snapshots.push(await snapshot());
        await fetch('/shaper?rate=0');
        // --auto extends recovery observation; adaptation always belongs to the product.
        phase = 'released'; await wait(automatic ? 40000 : 10000); snapshots.push(await snapshot());
    }
    return { descriptions, snapshots, browser: navigator.userAgent, sourcePulses,
        audioMonitors: audioMonitors.map(({ role, pulses, attached }) => ({ role, pulses, attached })),
        monitors: monitors.map(({ role, samples }) => ({ role, samples })) };
}
const configuration = { mode, codec, product: true, network, automatic, av, high, single, late,
    background, nativeSource, lifecycle, relay, shapedRate, profile: selectedProfile() };
try {
    window.probeResult = { ...configuration, ...await run(), controls, visibility, productTrace, errors };
    if (browserDebugEnabled) {
        const report = JSON.parse(await exportBrowserDebug());
        window.probeResult.debug = report;
        if (productPool && (!report.events.some(e => e.scope === 'encoding-pool' && e.event === 'sample') ||
            !report.events.some(e => e.scope === 'webrtc' && e.event === 'stats' && e.details.role === 'pool-producer')))
            throw Error('Debug report omitted the pool or producer evidence');
    }
} catch (error) {
    window.probeResult = { ...configuration, error: String(error?.stack || error?.message || error),
        progress: window.probeProgress(), controls, visibility, productTrace, errors };
} finally {
    clearInterval(drawing); clearInterval(productTraceTimer);
    monitors.forEach(m => m.stop()); audioMonitors.forEach(m => m.stop());
    productPeers.forEach(peer => peer.dispose()); productPool?.dispose();
    upstreamPeer?.dispose();
    tracks.forEach(t => t.stop()); peers.forEach(pc => pc.close());
    await audioContext?.close();
    window.probeDone = true;
}
