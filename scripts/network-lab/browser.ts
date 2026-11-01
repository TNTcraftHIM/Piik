import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from '../../prototype/channel-server/browser-fixture.mjs';
import { readPacketFlows } from './packets';
import type { LabNetwork } from './network';
import type { LabProcess } from './process';

export interface MediaLab {
  network: LabNetwork; output: string; source: string; executable: string; signal: AbortSignal;
  result: any;
  start(name: string, ns: string, program: string, args: string[], env?: NodeJS.ProcessEnv): LabProcess;
}

// Real ChannelSession/UI; synthetic capture is shared with normal acceptance.
export async function media(lab: MediaLab, mode: 'ordinary' | 'media' | 'browser-relay'): Promise<void> {
  const { network, output, source, executable, start, signal, result } = lab;
  const prepared = mode === 'media', relayed = mode === 'browser-relay';
  const origin = 'http://198.51.100.1:9000', room = 'kernel-lab-room';
  const indices = relayed ? [0, 1, 2] : [0, 1];
  const sessions = indices.map(index => network.prefix+'-browser'+index);
  let sourceBrowser = 0, viewerBrowser = 1, browserRelay: number | undefined;
  const browserOpened = new Set<number>();
  const browser = async (index: number, ...args: string[]) => {
    const commandArgs = ['netns', 'exec', network.endpoint(index + (prepared ? 2 : 1)), process.env.AGENT_BROWSER_BIN ?? 'agent-browser',
      '--session', sessions[index]!, '--json', '--executable-path', process.env.CHROMIUM_BIN ?? '/usr/bin/chromium',
      '--args', `--no-sandbox,--autoplay-policy=no-user-gesture-required,--disable-dev-shm-usage,--unsafely-treat-insecure-origin-as-secure=${origin}`,
      '--init-script', join(output, `${index}.js`), ...args];
    return new Promise<any>((resolve, reject) => {
      const child = spawn('ip', commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
      child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
      const timer = setTimeout(() => { child.kill(); reject(Error('owned Browser command deadline')); }, 35000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer);
        if (code) return reject(Error(stderr || stdout || `Browser exit${code}`));
        try { const value = JSON.parse(stdout); assert(value.success, value.error); resolve(value.data); } catch (error) { result.browserFailure = { index, command: args[0], code, stdout, stderr }; reject(error); }
      });
    });
  };
  const f = fixture(browser);
  const ice = (index: number) => f.evaluate(index, `(async()=>{const rows=[];for(const pc of window.__channelProbe.peers){const stats=await pc.getStats();rows.push({connectionState:pc.connectionState,iceConnectionState:pc.iceConnectionState,candidates:[...stats.values()].filter(row=>row.type==='candidate-pair'||row.type==='local-candidate'||row.type==='remote-candidate')});}return rows;})()`);
  let recoveryCapture: LabProcess | undefined;
  await writeFile(join(output, 'vite.config.mts'),
    'import { mergeConfig } from '+JSON.stringify(join(source, 'node_modules/vite/dist/node/index.js'))+';\n'
    + 'import base from '+JSON.stringify(join(source, 'vite.config.ts'))+';\n'
    + 'export default mergeConfig(base,{root:'+JSON.stringify(source)+',cacheDir:'+JSON.stringify(join(output, 'vite-cache'))+'});\n');
  try {
    const vite = start('vite', network.wan, process.execPath, [join(source, 'node_modules/vite/bin/vite.js'), '--host', '0.0.0.0', '--port', '9000', '--strictPort', '--config', join(output, 'vite.config.mts')],
      { ...process.env, PIIK_CHANNEL_PORT: '9001' });
    await vite.wait(() => vite.stdout.includes('9000'), signal);
    start('native-host', network.endpoint(0), executable, ['host', join(output, 'host')]);
    const relay = prepared ? start('native-relay', network.endpoint(1), executable, ['participant']) : undefined;
    if (relay) await relay.wait(() => relay.records.some(row => row.event?.type === 'admitted'), signal);
    for (const index of indices) {
      await writeFile(join(output, `${index}.js`), f.captureProbe(index ? 'Viewer' : 'Source'));
      browserOpened.add(index);
      await browser(index, 'open', `${origin}/__channel-preview#invite=owned-kernel-lab-invite`);
      await f.until(`Browser${index} admitted`, () => f.view(index), (value: any) => value.connection === 'connected');
      await f.action(index, `renameSelf(${JSON.stringify(index ? 'Owned viewer' : 'Owned source')})`);
      await f.until('Native room available', () => f.view(index), (value: any) => value.state.channel.rooms.some((entry: any) => entry.id === room && entry.available));
      await browser(index, 'click', '.c3-room-link[aria-label="Kernel room"]');
      await f.until('Room base DataChannel opens', () => f.sample(index), (value: any) => value.channels.some((entry: any) => entry.state === 'open'));
    }
    result.initial = await Promise.all(indices.map(index => f.view(index)));
    const pairs = result.initial.map((value: any) => value.state.pairs.find((pair: any) => pair.rooms.includes(room)));
    assert(pairs[0] && pairs[1]);
    result.nativeEndpoint = pairs[1].peerId;
    if (relayed) {
      const links = (value: any) => value.state.pairs.filter((pair: any) => pair.rooms.includes(room));
      result.initial = await f.until('Core forms the Browser relay base branch', () => Promise.all(indices.map(index => f.view(index))), (views: any[]) => {
        const native = views[0].state.channel.rooms.find((entry: any) => entry.id === room).delivery.hostSessionId;
        return views.some(view => links(view).length === 1 && links(view)[0].peerId !== native);
      });
      result.nativeEndpoint = result.initial[0].state.channel.rooms.find((entry: any) => entry.id === room).delivery.hostSessionId;
      viewerBrowser = result.initial.findIndex((value: any) => links(value).length === 1 && links(value)[0].peerId !== result.nativeEndpoint);
      browserRelay = result.initial.findIndex((value: any) => value.sessionId === links(result.initial[viewerBrowser])[0].peerId);
      sourceBrowser = indices.find(index => index !== viewerBrowser && index !== browserRelay)!;
      assert(browserRelay !== undefined && browserRelay >= 0 && sourceBrowser >= 0);
      assert(links(result.initial[sourceBrowser]).some((pair: any) => pair.peerId === result.nativeEndpoint));
      assert(links(result.initial[browserRelay]).some((pair: any) => pair.peerId === result.nativeEndpoint));
      result.roles = { sourceBrowser, browserRelay, viewerBrowser };
      for (const [index, role] of [[sourceBrowser, 'source'], [browserRelay, 'relay'], [viewerBrowser, 'viewer']] as const) {
        await f.action(index, `renameSelf(${JSON.stringify('Owned ' + role)})`);
      }
      result.mediaEdges = [[sourceBrowser + 1, 0], [0, browserRelay + 1], [browserRelay + 1, viewerBrowser + 1]];
      const shortcuts = [[sourceBrowser + 1, browserRelay + 1], [sourceBrowser + 1, viewerBrowser + 1], [0, viewerBrowser + 1]];
      result.blockedShortcuts = shortcuts.flatMap(([from, to]) => [[from, to], [to, from]]);
      for (const [from, to] of result.blockedShortcuts) network.exec(network.router(from), 'nft', [
        `add rule inet lab_filter faults ip daddr ${network.publicIP(to)} meta l4proto udp counter drop`,
      ]);
    } else if (relay) {
      assert.notEqual(pairs[0].peerId, pairs[1].peerId);
      result.preparedNativePairs = relay.records.filter(row => row.event?.type === 'plan')
        .flatMap(row => row.event.pairs).filter((pair: any) => pair.peerId === pairs[0].peerId && pair.preparation === 'required');
      assert(result.preparedNativePairs.length, 'Core must require Native UDP preparation');
      assert(relay.records.some(row => row.event?.type === 'native-signal' && row.event.udp === 'complete'));
      result.probeBoundary = 'Second Native is a NativePeers transport/media probe; conversation acceptance belongs to ordinary';
    } else {
      assert.equal(pairs[0].peerId, pairs[1].peerId);
    }
    if (!relayed) assert(!result.initial.some((value: any) => [pairs[0].peerId, pairs[1].peerId].includes(value.sessionId)));
    if (mode === 'ordinary') {
    await f.action(0, `sendMessage('${room}', 'Confirmed across calibrated NAT')`);
    await f.until('Native confirmed chat', () => f.evaluate(1, `${f.hook}.snapshot().messagesByRoom['${room}']`), (messages: any[]) => messages?.some(message => message.text === 'Confirmed across calibrated NAT'));
    await f.action(1, `loadLatestHistory('${room}')`);
    result.history = await f.evaluate(1, `${f.hook}.snapshot().messagesByRoom['${room}'].map(message => ({seq:message.seq,text:message.text}))`);
    const stored = new DatabaseSync(join(output, 'host/room.sqlite'), { readOnly: true });
    try { result.nativeConfirmedMessages = stored.prepare('SELECT count(*) AS count FROM message WHERE room_id=?').get(room)!.count; assert.equal(result.nativeConfirmedMessages, 1); } finally { stored.close(); }
    }
    await f.action(sourceBrowser, `joinVoice('${room}')`); await f.action(viewerBrowser, `joinVoice('${room}')`);
    await f.until('bidirectional Native-forwarded voice', () => Promise.all([sourceBrowser, viewerBrowser].map(index => f.sample(index))), (values: any[]) => values.every(value => value.inbound.some((row: any) => row.kind === 'audio' && row.samples > 0 && row.energy > 0)));
    await f.evaluate(sourceBrowser, 'window.__channelProbe.captureAudio(true)');
    const publication = await f.capturedScreen(sourceBrowser, room); result.publication = publication;
    await f.action(viewerBrowser, `watch(${JSON.stringify(publication)})`); await f.playing(viewerBrowser, publication); await f.audioProgressing(viewerBrowser, publication);
    const mediaSample = () => f.evaluate(viewerBrowser, `(async () => {
      const snap=${f.hook}.snapshot(), stream=snap.streams.get(${JSON.stringify(publication)});
      const video=[...document.querySelectorAll('video')].find(value=>value.srcObject===stream);
      if(!video || video.readyState<2)return null;
      const canvas=document.createElement('canvas');canvas.width=16;canvas.height=9;
      const ctx=canvas.getContext('2d');ctx.drawImage(video,0,0,16,9);
      const pixels=Array.from(ctx.getImageData(0,0,16,9).data);
      const stats=await window.__channelProbe.sample();
      const track=stream.getAudioTracks()[0];
      const pc=window.__channelProbe.peers.find(pc=>pc.connectionState==='connected'&&pc.getReceivers().some(receiver=>receiver.track===track));
      const audio=pc ? [...(await pc.getReceivers().find(receiver=>receiver.track===track).getStats()).values()]
        .filter(row=>row.type==='inbound-rtp'&&row.kind==='audio').map(row=>({id:row.id,samples:row.totalSamplesReceived,energy:row.totalAudioEnergy})) : [];
      return {atMs:Date.now(),width:video.videoWidth,height:video.videoHeight,frames:video.getVideoPlaybackQuality().totalVideoFrames,time:video.currentTime,pixels,
        audio,inbound:stats.inbound,connections:stats.connections,pairs:snap.state.pairs};})()`);
    const selectedPath = async (value: any) => {
      const parent = relayed ? result.initial[browserRelay!].sessionId : result.nativeEndpoint;
      assert(value.pairs.some((pair: any) => pair.peerId === parent && pair.incoming.some((flow: any) => flow.publicationId === publication && flow.selected)), 'selected picture must use the observed parent');
      if (relayed) {
        const middle = await f.view(browserRelay!);
        assert(middle.state.pairs.some((pair: any) => pair.peerId === result.nativeEndpoint && pair.incoming.some((flow: any) => flow.publicationId === publication && flow.selected)), 'Browser relay must receive the selected Native output');
        assert(middle.state.pairs.some((pair: any) => pair.peerId === result.initial[viewerBrowser].sessionId && pair.outgoing.some((flow: any) => flow.publicationId === publication && flow.selected)), 'Browser relay must send that publication to the viewer');
      }
    };
    result.mediaBefore = await mediaSample(); await delay(3000, undefined, { signal }); result.mediaAfter = await mediaSample();
    assert(result.mediaAfter.frames > result.mediaBefore.frames && result.mediaAfter.time > result.mediaBefore.time);
    assert.notDeepEqual(result.mediaAfter.pixels, result.mediaBefore.pixels, 'actual decoded pixels must change');
    await selectedPath(result.mediaAfter);
    if (relayed) {
      const node = browserRelay! + 1;
      result.sourceBeforeOutage = await f.sample(sourceBrowser);
      result.recovery = { blockedAt: Date.now() };
      network.setFault(node, 'udp-block', 1);
      await delay(50_000, undefined, { signal });
      result.blocked = network.counters(node);
      assert(result.blocked.faultDrops > 0, 'Relay blackout must drop actual traffic');
      let previous = await mediaSample();
      recoveryCapture = start('recovery-capture', network.wan, 'tcpdump', ['-i', 'internet', '-n', '-s', '96', '-U', '-w', join(output, 'recovery.pcap'), '-c', '10000', 'udp']);
      await recoveryCapture.wait(() => recoveryCapture!.stderr.includes('listening on'), signal);
      result.recovery.restoredAt = Date.now(); network.setFault(node, 'none', 1);
      for (const [from, to] of result.blockedShortcuts.filter(([from]: number[]) => from === node)) network.exec(network.router(from), 'nft', [
        `add rule inet lab_filter faults ip daddr ${network.publicIP(to)} meta l4proto udp counter drop`,
      ]);
      const recovered = await f.until('Browser relay decoded picture and source sound recover', mediaSample, (value: any) => {
        const advanced = value && previous && value.frames > previous.frames && value.time > previous.time && value.audio.some((row: any) =>
          previous.audio.some((before: any) => row.id === before.id && row.samples > before.samples && row.energy > before.energy));
        previous = value; return advanced;
      }, 30_000);
      Object.assign(result.recovery, { recoveredAt: Date.now(), before: recovered });
      await delay(3000, undefined, { signal }); result.recovery.after = await mediaSample();
      assert(result.recovery.after.frames > recovered.frames && result.recovery.after.time > recovered.time);
      assert.notDeepEqual(result.recovery.after.pixels, recovered.pixels);
      await selectedPath(result.recovery.after);
      result.sourceAfterOutage = await f.sample(sourceBrowser);
      assert.deepEqual(result.sourceAfterOutage.captures, result.sourceBeforeOutage.captures, 'The original capture must stay live through transport recovery');
    }
    await browser(viewerBrowser, 'screenshot', join(output, 'decoded-native-transit.png'));
    result.ice = await Promise.all(indices.map(index => f.evaluate(index, `(async()=>{const rows=[];for(const pc of window.__channelProbe.peers){const stats=await pc.getStats();for(const row of stats.values())if(row.type==='candidate-pair'&&row.state==='succeeded'&&row.nominated)rows.push({pair:row,local:stats.get(row.localCandidateId),remote:stats.get(row.remoteCandidateId)});}return rows;})()`)));
    if (mode === 'ordinary') {
    const bytes = 1024 * 1024 + 17;
    const expected = createHash('sha256').update(Buffer.from(Array.from({ length: bytes }, (_, index) => index % 251))).digest('hex');
    await f.evaluate(sourceBrowser, `(async()=>{const bytes=Uint8Array.from({length:${bytes}},(_,i)=>i%251);await ${f.hook}.session.sendMessage('${room}','File through Native',[{id:crypto.randomUUID(),file:new File([bytes],'owned-proof.bin')}]);return true;})()`);
    const fileMessage = await f.until('Native confirms file description', () => f.evaluate(viewerBrowser, `${f.hook}.snapshot().messagesByRoom['${room}']?.find(message=>message.text==='File through Native')`), Boolean);
    assert.equal(fileMessage.attachments[0].sha256, expected);
    result.file = await f.evaluate(viewerBrowser, `(async()=>{const message=${JSON.stringify(fileMessage)},attachment=message.attachments[0];const file=await ${f.hook}.session.attachments.content({roomId:'${room}',messageSeq:message.seq,attachmentId:attachment.id},attachment,new AbortController().signal);const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());return {size:file.size,sha256:[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('')};})()`);
    assert.equal(result.file.size, bytes); assert.equal(result.file.sha256, expected);
    }
    await f.progressing(viewerBrowser, publication); await f.audioProgressing(viewerBrowser, publication);
    result.final = await Promise.all(indices.map(index => f.view(index)));
    await f.action(sourceBrowser, `stopScreen(${JSON.stringify(publication)})`);
    await f.until('source retirement reaches viewer', () => f.view(viewerBrowser), (value: any) => !value.state.publications.some((entry: any) => entry.id === publication));
    for (const index of [sourceBrowser, viewerBrowser]) await f.action(index, `leaveVoice('${room}')`);
    for (const index of indices) await f.assertNoError(index, 'kernel NAT media');
    result.stop = await Promise.all(indices.map(index => f.sample(index)));
    assert(result.stop.every((value: any) => value.captures.every((track: any) => track.state === 'ended')));
  } catch (error) {
    result.failure = { atMs: Date.now(), browsers: await Promise.allSettled([...browserOpened].map(async index => ({
      index, view: await f.view(index), sample: await f.sample(index), ice: await ice(index),
    }))) };
    if (relayed && result.roles) result.failure.routers = await Promise.allSettled(indices.map(async index => ({ index: index + 1,
      counters: network.counters(index + 1),
      nat: JSON.parse(network.exec(network.router(index + 1), 'nft', ['-j', 'list', 'table', 'ip', 'lab_nat'])),
    })));
    throw error;
  } finally {
    const closed = await Promise.allSettled([...browserOpened].map(index => browser(index, 'close')));
    if (recoveryCapture) {
      await recoveryCapture.close('SIGINT');
      result.recoveryPacketFlows = await readPacketFlows(join(output, 'recovery.pcap'));
    }
    const errors = closed.filter(value => value.status === 'rejected').map(value => value.reason);
    if (errors.length) throw new AggregateError(errors, 'Owned Browser cleanup failed');
  }
}
