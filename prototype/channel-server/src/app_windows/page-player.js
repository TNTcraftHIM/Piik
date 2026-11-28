// This bridge observes and controls media only. Website data never carries App authority.
(() => {
  const uuid = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  };
  const frame = uuid(), elements = new Map(), byVideo = new WeakMap();
  const children = new Map();
  const encoder = new TextEncoder();
  const forward = message => {
    if (window !== top) { parent.postMessage(message, '*'); return; }
    const envelope = { ...message, document: frame };
    const post = value => window.chrome.webview.postMessage(JSON.stringify(value));
    if (message.kind !== 'resources' && message.kind !== 'candidates') { post(envelope); return; }
    const field = message.kind === 'resources' ? 'urls' : 'candidates';
    // Native caps the complete UTF-8 IPC body at 64 KiB, including frame ancestry.
    const base = encoder.encode(JSON.stringify({ ...envelope, [field]: [] })).length;
    let items = [], bytes = base;
    for (const item of message[field]) {
      const length = encoder.encode(JSON.stringify(item)).length;
      if (items.length && (items.length === 128 || bytes + 1 + length > 65536)) {
        post({ ...envelope, [field]: items }); items = []; bytes = base;
      }
      if (base + length > 65536) continue;
      bytes += length + (items.length ? 1 : 0); items.push(item);
    }
    if (items.length || message.removed?.length) post({ ...envelope, [field]: items });
  };
  const send = payload => forward({ bridge: 'piik-page-player', frame, ancestors: [], ...payload });
  addEventListener('message', event => {
    if (event.source === window || event.data?.bridge !== 'piik-page-player') return;
    const element = [...document.querySelectorAll('iframe')].find(iframe => iframe.contentWindow === event.source);
    if (!element || children.size >= 64 && !children.has(event.source)) return;
    const ancestors = event.data.ancestors;
    if (!Array.isArray(ancestors) || ancestors.length >= 32) return;
    const childFrame = ancestors[0] || event.data.frame, previous = children.get(event.source);
    if (previous && previous.frame !== childFrame) send({ kind: 'removed', removed: previous.frame });
    children.set(event.source, { element, frame: childFrame });
    forward({ ...event.data, ancestors: [frame, ...ancestors] });
  });
  if (window === top) send({ kind: 'document' });
  const resources = new PerformanceObserver(list => {
    let urls = [];
    for (const entry of list.getEntries()) {
      if (entry.name.length > 4096 || !/^https?:\/\//.test(entry.name)) continue;
      urls.push(entry.name);
      if (urls.length === 128) { send({ kind: 'resources', urls }); urls = []; }
    }
    if (urls.length) send({ kind: 'resources', urls });
  });
  resources.observe({ type: 'resource', buffered: true });
  const state = video => ({ position: video.currentTime, paused: video.paused, rate: video.playbackRate,
    duration: Number.isFinite(video.duration) ? video.duration : null, readyState: video.readyState, ended: video.ended,
    buffered: Array.from({ length: video.buffered.length }, (_, index) => [video.buffered.start(index), video.buffered.end(index)]) });
  let timer;
  const identity = video => {
    if (video.srcObject) return video.srcObject;
    if (video.currentSrc) return video.currentSrc;
    // A fresh element can declare its source before the browser selects it.
    const src = video.getAttribute('src');
    if (src !== null) return src.trim() ? video.src : null;
    const sources = video.querySelectorAll(':scope > source');
    return sources.length === 1 && sources[0].getAttribute('src')?.trim() ? sources[0].src : null;
  };
  const resource = entry => {
    const value = identity(entry.video) ?? '';
    if (value !== entry.identity) {
      // The first source binds an empty selection. Later replacements retire resource-bound commands.
      if (entry.identity) entry.revision++;
      entry.identity = value;
      // Native correlates ordinary URLs with responses. Keep objects and oversized URLs local.
      entry.resource = typeof value === 'string' && value.length <= 4096 && encoder.encode(value).length <= 4096 ? value : uuid();
    }
    return entry.resource;
  };
  let reported;
  const report = () => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      // Resolve replacements against the whole candidate batch, including separate DOM mutations.
      const previous = [...elements.keys()];
      discoverVideos();
      const removed = previous.filter(id => !elements.has(id));
      const candidates = [...elements].map(([media, entry]) => {
        const { video } = entry;
        const observed = resource(entry);
        let url = null;
        if (observed && observed === video.currentSrc) {
          try { const source = new URL(observed); if (['http:', 'https:'].includes(source.protocol) && !source.username && !source.password) url = source.href; } catch {}
        }
        const title = video.getAttribute('aria-label') || video.title || document.title || location.hostname;
        return { media, resource: observed, revision: entry.revision, title: title.match(/^.{0,256}/su)[0].toWellFormed(), url,
          duration: Number.isFinite(video.duration) ? video.duration : null };
      });
      // A site's document changes all the time. The same list sent again costs the App's window
      // thread a catalog and the room page a whole render for every batch, about twelve a second.
      const next = JSON.stringify([location.href, removed, candidates]);
      if (next === reported) return;
      reported = next;
      send({ kind: 'candidates', removed, candidates });
    }, 80);
  };
  const discoverVideos = () => {
    const videos = document.querySelectorAll('video');
    const removed = [...elements].filter(([, entry]) => !entry.video.isConnected);
    if (removed.length && videos.length <= 64) {
      const sources = Array.from(videos, video => ({ video, source: identity(video) }));
      for (const [, entry] of removed) {
        // A page can rebuild several players together. Only one-to-one source matches inherit commands.
        if (!entry.identity || removed.some(([, other]) => other !== entry && other.identity === entry.identity)) continue;
        const matches = sources.filter(({ source }) => source === entry.identity);
        if (matches.length === 1 && !byVideo.has(matches[0].video)) {
          byVideo.delete(entry.video);
          byVideo.set(matches[0].video, entry);
        }
      }
    }
    for (const [id, entry] of removed) { entry.lifetime.abort(); elements.delete(id); }
    for (const video of videos) {
      if (elements.size >= 64) break;
      const entry = byVideo.get(video) || { media: uuid(), revision: 0 };
      const { media } = entry;
      if (elements.has(media)) continue;
      const lifetime = new AbortController();
      entry.video = video;
      entry.lifetime = lifetime;
      byVideo.set(video, entry); elements.set(media, entry);
      for (const event of ['emptied', 'loadstart']) video.addEventListener(event, report, { signal: lifetime.signal });
      for (const event of ['emptied', 'loadedmetadata', 'loadeddata', 'play', 'playing', 'pause', 'seeked', 'ratechange', 'ended', 'waiting', 'error']) {
        video.addEventListener(event, () => {
          if (!video.isConnected) return;
          send({ kind: 'sample', media, resource: resource(entry), revision: entry.revision, event });
          if (event === 'loadedmetadata' || event === 'loadeddata') report();
        }, { signal: lifetime.signal });
      }
    }
  };
  const discover = () => {
    for (const [source, child] of children) if (!child.element.isConnected) { children.delete(source); send({ kind: 'removed', removed: child.frame }); }
    report();
  };
  new MutationObserver(discover).observe(document, { childList: true, subtree: true, attributeFilter: ['title', 'aria-label'] });
  addEventListener('DOMContentLoaded', discover, { once: true });
  addEventListener('pagehide', () => {
    clearTimeout(timer);
    timer = undefined;
    send({ kind: 'removed', removed: frame });
  });
  addEventListener('message', event => {
    const command = event.data;
    if (command?.bridge !== 'piik-page-command') return;
    for (const iframe of document.querySelectorAll('iframe')) iframe.contentWindow?.postMessage(command, '*');
    if (command.frame !== frame) return;
    const entry = elements.get(command.media), video = entry?.video;
    if (video?.isConnected) resource(entry);
    if (!video?.isConnected || !command.originalPage && entry.revision !== command.revision) {
      send({ kind: 'reply', request: command.request, error: 'page_candidate_unavailable' });
      return;
    }
    try {
      if (command.kind === 'patch') {
        const value = command.patch;
        if (value.position !== undefined) video.currentTime = value.position;
        if (value.rate !== undefined) video.playbackRate = value.rate;
        if (value.paused !== undefined) {
          entry.playRequest = command.request;
          const playRevision = entry.revision;
          if (value.paused) video.pause();
          else void video.play().catch(error => {
            if (!video.isConnected || entry.video !== video || entry.playRequest !== command.request || error?.name === 'AbortError') return;
            const observed = resource(entry);
            if (entry.revision !== playRevision) return;
            if (error?.name === 'NotAllowedError') send({ kind: 'blocked', media: command.media });
            else send({ kind: 'sample', media: command.media, resource: observed, revision: entry.revision, event: 'error' });
          });
        }
      }
      send({ kind: 'reply', request: command.request, state: state(video) });
    } catch (error) {
      const blocked = error?.name === 'NotAllowedError';
      if (blocked) send({ kind: 'blocked', media: command.media });
      send({ kind: 'reply', request: command.request, error: blocked ? 'watch_autoplay_blocked' : 'watch_media_failed' });
    }
  });
})();
