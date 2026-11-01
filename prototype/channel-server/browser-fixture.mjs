// Shared owned-canvas/audio fixture for normal and kernel-NAT Browser acceptance.
import assert from "node:assert/strict";

export function fixture(browser) {
async function evaluate(index, expression) {
  const script = `(async () => JSON.stringify(await (${expression})))()`;
  const data = await browser(index, "eval", "-b", Buffer.from(script).toString("base64"));
  return data.result === undefined ? undefined : JSON.parse(data.result);
}
async function until(label, sample, predicate, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await sample();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}

function captureProbe(name) {
  return `(() => {
    localStorage.setItem('piik:ui-lang', 'en');
    localStorage.setItem('piik:ui-mode', 'text');
    const peers = [], sockets = [], captures = [], contexts = [], protocol = [], channels = [], warnings = [], flowStates = [], audioSources = [], qualitySamples = [], restoredVideo = [];
    const trackObjects = new WeakMap();
    const trackObjectId = track => { if (!trackObjects.has(track)) trackObjects.set(track, crypto.randomUUID()); return trackObjects.get(track); };
    let qualityInstalled = false;
    let captureAudio = false;
    const conversationWS = Object.create(null);
    const warn = console.warn.bind(console);
    console.warn = (...args) => { warnings.push(args.map(value => String(value))); if (warnings.length > 20) warnings.shift(); warn(...args); };
    const blockedPeers = new Set(), pairPeers = new Map(), flowBindings = new Map(), flowStreams = new Map(), senders = [], channelOwners = new Map();
    let videoStall = null;
    let blockedOffers = 0;
    const record = (direction, data) => {
      const event = JSON.parse(data);
      const command = event.input?.action?.command;
      const type = command?.type ?? ((event.output?.reply?.result?.type ?? event.result?.type) === 'history' ? 'history' : event.type);
      const room = command?.roomId ?? event.roomId;
      if (room && (type === 'chat' || type === 'history')) {
        const counts = conversationWS[room] ??= { sent: { chat: 0, history: 0 }, received: { chat: 0, history: 0 } };
        counts[direction][type]++;
      }
      for (const pair of event.state?.pairs ?? []) {
        pairPeers.set(pair.id, pair.peerId);
        for (const flow of [...pair.incoming, ...pair.outgoing]) flowBindings.set(flow.id, flow);
      }
      if (direction === 'sent' && event.type === 'signal') for (const track of event.payload.tracks ?? []) flowStreams.set(track.flowId, track.streamId);
      if (direction === 'sent' && event.type === 'flow_state') {
        flowStates.push({ flowId: event.flowId, state: event.state, time: Date.now() });
        if (flowStates.length > 128) flowStates.shift();
      }
      protocol.push({ direction, type:event.type, room:event.roomId, request:event.requestId,
        action:event.input?.action?.type, revision:event.input?.revision ?? event.output?.revision,
        binding:event.bindingId ?? event.input?.bindingId ?? event.output?.bindingId,
        result:event.result?.type ?? event.output?.reply?.result?.type, code:event.code,
        pair:event.pairId, ready:event.ready, state:event.state && typeof event.state === 'string' ? event.state : undefined });
      if (protocol.length > 64) protocol.shift();
      return event;
    };
    const NativePC = window.RTCPeerConnection, NativeWS = window.WebSocket;
    const recordChannel = (pc, channel) => {
      channels.push(channel);
      const owned = channelOwners.get(pc) ?? []; owned.push(channel); channelOwners.set(pc, owned);
      return channel;
    };
    window.RTCPeerConnection = class extends NativePC {
      constructor(...args) { super(...args); peers.push(this); this.addEventListener('datachannel', event => recordChannel(this, event.channel)); }
      createDataChannel(...args) { return recordChannel(this, super.createDataChannel(...args)); }
      addTransceiver(track, options) {
        const transceiver = super.addTransceiver(track, options);
        senders.push({ pc: this, sender: transceiver.sender, id: crypto.randomUUID(),
          streams: (options?.streams ?? []).map(stream => stream.id) });
        return transceiver;
      }
      addTrack(track, ...streams) {
        const sender = super.addTrack(track, ...streams);
        senders.push({ pc: this, sender, id: crypto.randomUUID(), streams: streams.map(stream => stream.id) });
        return sender;
      }
    };
    window.WebSocket = class extends NativeWS {
      constructor(...args) { super(...args); sockets.push(this); this.addEventListener('message', message => {
        const event = record('received', message.data);
        if (event.type === 'signal' && blockedPeers.has(event.fromSessionId)) {
          if (event.payload?.description?.type === 'offer') blockedOffers++;
          message.stopImmediatePropagation();
        }
      }); }
      send(data) { const event = record('sent', data);
        if (event.type === 'signal' && blockedPeers.has(pairPeers.get(event.pairId))) return;
        const fault = videoStall;
        const binding = fault && event.type === 'signal' && event.payload?.description && pairPeers.get(event.pairId) === fault.peerId
          && event.payload.tracks?.find(track => flowBindings.get(track.flowId)?.publicationId === fault.publicationId
            && (!fault.candidateOnly || flowBindings.get(track.flowId)?.selected === false));
        if (binding) {
          if (!fault.pending) {
            const output = senders.find(output => output.pc.localDescription?.sdp === event.payload.description.sdp
              && output.streams.includes(binding.streamId) && output.sender.track?.kind === 'video');
            fault.pending = (async () => {
              if (!output || event.payload.description.type !== 'offer') throw new Error('Video stall requires its initial sender offer');
              const parameters = output.sender.getParameters();
              if (!parameters.encodings?.length) throw new Error('Video sender has no controllable encoding');
              parameters.encodings.forEach(encoding => { encoding.active = false; });
              await output.sender.setParameters(parameters);
              Object.assign(fault, { output, pairId: event.pairId, flowId: binding.flowId, startedAt: Date.now() });
            })();
          }
          // Install the real sender fault before its original offer can reach the receiver.
          void fault.pending.then(() => super.send(data)).catch(error => { fault.error = String(error); });
          return;
        }
        return super.send(data);
      }
    };
    const createAudioSource = AudioContext.prototype.createMediaStreamSource;
    AudioContext.prototype.createMediaStreamSource = function(stream) {
      const source = createAudioSource.call(this, stream);
      const track = stream.getAudioTracks()[0];
      const owner = { trackId: track.id, trackObjectId: trackObjectId(track), context: this, connected: false };
      audioSources.push(owner);
      const connect = source.connect.bind(source), disconnect = source.disconnect.bind(source);
      source.connect = (...args) => { owner.connected = true; return connect(...args); };
      source.disconnect = (...args) => { owner.connected = false; return disconnect(...args); };
      return source;
    };
    const microphone = (stereo = false) => {
      const context = new AudioContext();
      contexts.push(context);
      const frequencies = stereo ? [500, 1500] : [${330 + name.charCodeAt(0)}];
      const channels = context.createChannelMerger(frequencies.length);
      const oscillators = frequencies.map((frequency, channel) => {
        const oscillator = context.createOscillator();
        oscillator.frequency.value = frequency;
        oscillator.connect(channels, 0, channel); oscillator.start();
        return oscillator;
      });
      const gain = context.createGain(), destination = context.createMediaStreamDestination();
      gain.gain.value = .05; channels.connect(gain); gain.connect(destination);
      const track = destination.stream.getAudioTracks()[0], stop = track.stop.bind(track);
      track.stop = () => { stop(); oscillators.forEach(oscillator => oscillator.stop()); void context.close(); };
      void context.resume(); captures.push(destination.stream); return destination.stream;
    };
    navigator.mediaDevices.getUserMedia = async options => {
      if (options.video) throw new Error('This gate only substitutes microphone capture');
      return microphone();
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d'); let frame = 0;
      const timer = setInterval(() => {
        ctx.fillStyle = 'hsl(' + (frame++ % 360) + ' 70% 40%)'; ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = 'white'; ctx.font = '40px sans-serif'; ctx.fillText('${name} ' + frame, 40, 150);
      }, 100);
      const stream = canvas.captureStream(10); captures.push(stream);
      const track = stream.getVideoTracks()[0], stop = track.stop.bind(track);
      track.stop = () => { clearInterval(timer); stop(); };
      if (captureAudio) for (const audio of microphone(true).getAudioTracks()) stream.addTrack(audio);
      return stream;
    };
    window.__channelProbe = { peers, sockets, captures, contexts,
      captureAudio(enabled) { captureAudio = enabled; },
      async screenAudioSeparation(publicationId) {
        const stream = window.__channelGate.snapshot().streams.get(publicationId);
        if (!stream?.getAudioTracks().length) throw new Error('No received screen sound');
        const context = new AudioContext();
        try {
          const input = context.createMediaStreamSource(stream);
          const splitter = context.createChannelSplitter(2), sink = context.createGain();
          sink.gain.value = 0; sink.connect(context.destination); input.connect(splitter);
          const analyzers = [0, 1].map(channel => {
            const analyzer = context.createAnalyser();
            analyzer.fftSize = 8192; analyzer.smoothingTimeConstant = 0;
            splitter.connect(analyzer, channel); analyzer.connect(sink); return analyzer;
          });
          await context.resume();
          await new Promise(resolve => setTimeout(resolve, 1000));
          return analyzers.map((analyzer, channel) => {
            const bins = new Float32Array(analyzer.frequencyBinCount);
            analyzer.getFloatFrequencyData(bins);
            const level = frequency => {
              const bin = Math.round(frequency * analyzer.fftSize / context.sampleRate);
              return Math.max(-120, ...bins.slice(bin - 1, bin + 2));
            };
            return level(channel === 0 ? 500 : 1500) - level(channel === 0 ? 1500 : 500);
          });
        } finally { await context.close(); }
      },
      async observeQuality() {
        if (qualityInstalled) return;
        const { P2pQualityProbe } = await import('/src/client/media/candidate-quality-probe.ts');
        const observe = P2pQualityProbe.prototype.observe;
        const metrics = value => value && Object.fromEntries([
          'trackIdentifier', 'rtpStatsId', 'rtpSsrc', 'sampleTimestampMs', 'sampleWindowMs',
          'frameWidth', 'frameHeight', 'framesPerSecond', 'intervalFramesDecoded', 'bitrateKbps',
          'intervalFreezeCount', 'intervalFreezeDurationMs', 'intervalPauseCount', 'intervalPauseDurationMs',
        ].map(key => [key, value[key]]));
        P2pQualityProbe.prototype.observe = function(current, candidate) {
          const result = observe.call(this, current, candidate);
          qualitySamples.push({ time: Date.now(), current: metrics(current), candidate: metrics(candidate), result });
          if (qualitySamples.length > 128) qualitySamples.shift();
          return result;
        };
        qualityInstalled = true;
      },
      screen(publicationId) {
        const snapshot = window.__channelGate.snapshot();
        return { streamId: snapshot.streams.get(publicationId)?.id,
          inputs: (snapshot.screenInputs.get(publicationId) ?? []).map(input => {
            const element = [...document.querySelectorAll('video')].find(video => video.dataset.flowId === input.flowId);
            if (element) element.__allocationIdentity ??= crypto.randomUUID();
            return { flowId: input.flowId, selected: input.selected, switchReady: input.switchReady, streamId: input.stream.id,
              audio: input.stream.getAudioTracks().map(track => track.id), audioObjects: input.stream.getAudioTracks().map(trackObjectId),
              video: input.stream.getVideoTracks().map(track => track.id), elementId: element?.__allocationIdentity,
              displayed: element?.dataset.selected, composited: element?.dataset.composited, muted: element?.muted,
              paused: element?.paused, fullscreen: !!element && document.fullscreenElement === element.parentElement,
              volume: element?.volume, width: element?.videoWidth, height: element?.videoHeight,
              frames: element?.getVideoPlaybackQuality().totalVideoFrames, time: element?.currentTime };
          }), outputs: snapshot.state.pairs.flatMap(pair => pair.outgoing.filter(flow => flow.publicationId === publicationId).map(flow => {
            const streamId = flowStreams.get(flow.id);
            return { flowId: flow.id, inputFlowId: flow.inputFlowId, streamId, pairId: pair.id,
              senders: senders.filter(output => streamId && output.streams.includes(streamId) && output.sender.track)
                .map(output => ({ id: output.id, trackId: output.sender.track.id, kind: output.sender.track.kind })) };
          })), flowStates, qualitySamples, restoredVideo,
          audioOwners: audioSources.filter(owner => owner.connected && owner.context.state === 'running').map(owner => owner.trackObjectId) };
      },
      async decodedVideo(publicationId, flowId) {
        const track = window.__channelGate.snapshot().screenInputs.get(publicationId)
          ?.find(input => input.flowId === flowId)?.stream.getVideoTracks()[0];
        const receiver = track && peers.filter(pc => pc.connectionState === 'connected')
          .flatMap(pc => pc.getReceivers()).find(receiver => receiver.track === track);
        if (!receiver) return null;
        const report = [...(await receiver.getStats()).values()]
          .find(report => report.type === 'inbound-rtp' && report.kind === 'video' && Number.isFinite(report.framesDecoded));
        return report && { id: report.id, frames: report.framesDecoded, timestamp: report.timestamp,
          width: report.frameWidth, height: report.frameHeight };
      },
      blockPeer(sessionId) { blockedPeers.add(sessionId); },
      unblockPeer(sessionId) { blockedPeers.delete(sessionId); },
      async limitVideo(publicationId, peerId, maxFramerate, scaleResolutionDownBy) {
        const pair = window.__channelGate.snapshot().state.pairs.find(pair => pair.peerId === peerId);
        const flow = pair?.outgoing.find(flow => flow.publicationId === publicationId && flow.selected);
        const streamId = flow && flowStreams.get(flow.id);
        const output = senders.find(output => output.pc.connectionState === 'connected'
          && output.streams.includes(streamId) && output.sender.track?.kind === 'video');
        if (!output) return null;
        const settings = () => { const value = output.sender.track.getSettings();
          return { width: value.width, height: value.height, frameRate: value.frameRate }; };
        const encodings = sender => sender.getParameters().encodings.map(encoding => ({
          active: encoding.active, maxFramerate: encoding.maxFramerate, scaleResolutionDownBy: encoding.scaleResolutionDownBy,
        }));
        const others = () => senders.filter(value => value.sender !== output.sender && value.sender.track?.kind === 'video')
          .map(value => ({ senderId: value.id, encodings: encodings(value.sender) }));
        const before = { settings: settings(), encodings: encodings(output.sender), others: others() };
        const parameters = output.sender.getParameters();
        parameters.encodings.forEach(encoding => { encoding.maxFramerate = maxFramerate; encoding.scaleResolutionDownBy = scaleResolutionDownBy; });
        await output.sender.setParameters(parameters);
        return { flowId: flow.id, pairId: pair.id, streamId, senderId: output.id,
          before, after: { settings: settings(), encodings: encodings(output.sender), others: others() } };
      },
      stallVideo(publicationId, peerId, candidateOnly = false) { videoStall = { publicationId, peerId, candidateOnly }; },
      async restoreVideo() {
        const fault = videoStall; videoStall = null;
        await fault?.pending?.catch(() => {});
        if (!fault?.output?.sender.track || fault.output.pc.connectionState === 'closed') return;
        const parameters = fault.output.sender.getParameters();
        parameters.encodings.forEach(encoding => { encoding.active = true; });
        await fault.output.sender.setParameters(parameters);
        restoredVideo.push({ publicationId: fault.publicationId, peerId: fault.peerId, flowId: fault.flowId,
          trackId: fault.output.sender.track.id, restoredAt: Date.now(), active: fault.output.sender.getParameters().encodings.map(encoding => encoding.active) });
      },
      closeDataChannels() { for (const channel of channels) channel.close(); },
      async sample() {
        const inbound = [], outbound = [];
        for (const pc of peers) if (pc.connectionState === 'connected') {
          for (const stat of (await pc.getStats()).values()) {
            if (stat.type === 'inbound-rtp') inbound.push({ kind: stat.kind, bytes: stat.bytesReceived,
              frames: stat.framesDecoded, samples: stat.totalSamplesReceived, energy: stat.totalAudioEnergy });
            if (stat.type === 'outbound-rtp') outbound.push({ kind: stat.kind, bytes: stat.bytesSent, frames: stat.framesEncoded });
          }
        }
        const fault = videoStall, stalled = fault?.output;
        let stalledBytes = 0;
        if (stalled?.sender.track) for (const report of (await stalled.sender.getStats()).values()) {
          if (report.type === 'outbound-rtp' && report.kind === 'video') stalledBytes += report.bytesSent ?? 0;
        }
        return { inbound, outbound, protocol, conversationWS, warnings, blockedOffers, qualitySamples, restoredVideo,
          videoStall: fault && { publicationId: fault.publicationId, peerId: fault.peerId, pairId: fault.pairId,
            flowId: fault.flowId, startedAt: fault.startedAt, error: fault.error, bytes: stalledBytes,
            connected: stalled?.pc.connectionState === 'connected',
            roomOpen: stalled && channelOwners.get(stalled.pc)?.some(channel => channel.label === 'piik-room' && channel.readyState === 'open'),
            active: stalled?.sender.getParameters().encodings.map(encoding => encoding.active) },
          connections: peers.map(pc => pc.connectionState),
          channels: channels.map(channel => ({ label: channel.label, state: channel.readyState })),
          videos: [...document.querySelectorAll('video')].map(video => ({ time: video.currentTime,
            frames: video.getVideoPlaybackQuality().totalVideoFrames, width: video.videoWidth, paused: video.paused })),
          captures: captures.flatMap(stream => stream.getTracks().map(track => ({ kind: track.kind, state: track.readyState }))),
          overflow: document.documentElement.scrollWidth > innerWidth,
          text: document.body.innerText.slice(-1800) };
      }
    };
  })()`;
}

const hook = "window.__channelGate";
const action = async (index, expression) => {
  try { return await evaluate(index, `${hook}.session.${expression}`); }
  catch (cause) { throw new Error(`Browser ${index} ${expression.split('(')[0]} failed`, { cause }); }
};
const view = index => evaluate(index, `(() => {
  const value = ${hook}?.snapshot();
  if (!value) return { connection: 'connecting', state: null };
  return { sessionId: value.sessionId, connection: value.connection, self: value.self,
    state: value.state && { channel: value.state.channel, publications: value.state.publications,
      subscriptions: value.state.subscriptions, pairs: value.state.pairs, voice: value.state.voice, files: value.state.files },
    streams: [...value.streams.keys()], error: value.error };
})()`);
const picture = (index, publicationId) => evaluate(index, `(() => {
  const stream = ${hook}.snapshot().streams.get(${JSON.stringify(publicationId)});
  const video = [...document.querySelectorAll('video')].find(element => element.srcObject === stream);
  return { received: !!stream, frames: video?.getVideoPlaybackQuality().totalVideoFrames ?? 0,
    time: video?.currentTime ?? 0, live: stream?.getVideoTracks().some(track => track.readyState === 'live') ?? false };
})()`);
async function playing(index, publicationId) {
  return until(`browser ${index} decodes ${publicationId}`, () => picture(index, publicationId),
    sample => sample.live && sample.frames > 0);
}
async function progressing(index, publicationId) {
  let before = await playing(index, publicationId);
  return until(`browser ${index} advances ${publicationId}`, () => picture(index, publicationId),
    sample => {
      const advanced = sample.live && sample.frames > before.frames && sample.time > before.time;
      // A repaired route can replace the player and reset its frame/time counters.
      before = sample;
      return advanced;
    });
}
const publishScreen = (index, roomId) => action(index,
  `publish('screen', ${JSON.stringify(roomId)}, await navigator.mediaDevices.getDisplayMedia({video:true}))`);
async function capturedScreen(index, roomId) {
  await action(index, `startScreen(${JSON.stringify(roomId)})`);
  const current = await until("captured screen is admitted", () => view(index), value => value.state.publications.some(publication =>
    publication.sessionId === value.sessionId && publication.roomId === roomId && publication.kind === "screen"));
  return current.state.publications.find(publication => publication.sessionId === current.sessionId && publication.roomId === roomId && publication.kind === "screen").id;
}
const sample = index => evaluate(index, "window.__channelProbe.sample()");
async function audioProgressing(index, publicationId) {
  let previous = null;
  return until(`browser ${index} receives advancing audio ${publicationId}`, () => evaluate(index, `(async () => {
    const current = () => ${hook}.snapshot().streams.get(${JSON.stringify(publicationId)});
    const track = current()?.getAudioTracks().find(track => track.readyState === 'live');
    if (!track) return null;
    const pc = window.__channelProbe.peers.find(pc => pc.connectionState === 'connected'
      && pc.getReceivers().some(receiver => receiver.track === track));
    const receiver = pc?.getReceivers().find(receiver => receiver.track === track);
    if (!receiver) return null;
    const stats = await receiver.getStats();
    if (pc.connectionState !== 'connected' || !current()?.getAudioTracks().includes(track)) return null;
    return { trackId: track.id, reports: [...stats.values()]
      .filter(report => report.type === 'inbound-rtp' && report.kind === 'audio' && report.isRemote !== true)
      .map(report => ({ id: report.id, samples: report.totalSamplesReceived, energy: report.totalAudioEnergy })) };
  })()`), current => {
    const advancing = current && previous?.trackId === current.trackId && current.reports.some(report => {
      const before = previous.reports.find(before => before.id === report.id);
      return before && Number.isFinite(report.samples) && Number.isFinite(report.energy)
        && report.samples > before.samples && report.energy > before.energy;
    });
    previous = current;
    return advancing;
  });
}
async function assertNoError(index, flow) {
  const current = await view(index);
  if (current.error === null) return;
  assert.fail(`${flow} left an unexpected error in browser ${index}: ${JSON.stringify({
    error: current.error, protocol: (await sample(index)).protocol,
  })}`);
}
return { evaluate, until, captureProbe, hook, action, view, picture, playing, progressing, publishScreen, capturedScreen, sample, audioProgressing, assertNoError };
}
