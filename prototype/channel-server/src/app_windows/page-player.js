// This bridge observes and controls media only. Website data never carries App authority.
(() => {
  const uuid = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  };
  const frame = uuid(), elements = new Map(), ids = new WeakMap();
  const children = new Map();
  const forward = message => {
    if (window === top) window.chrome.webview.postMessage(JSON.stringify({ ...message, document: frame }));
    else parent.postMessage(message, '*');
  };
  const send = payload => forward({ bridge: 'piik-page-player', frame, ancestors: [], ...payload });
  addEventListener('message', event => {
    if (event.source === window || event.data?.bridge !== 'piik-page-player') return;
    const element = [...document.querySelectorAll('iframe')].find(iframe => iframe.contentWindow === event.source);
    if (!element || children.size >= 64 && !children.has(event.source)) return;
    const ancestors = event.data.ancestors;
    if (!Array.isArray(ancestors) || ancestors.length >= 32) return;
    children.set(event.source, { element, frame: ancestors[0] || event.data.frame });
    forward({ ...event.data, ancestors: [frame, ...ancestors] });
  });
  if (window === top) send({ kind: 'document' });
  const state = video => ({ position: video.currentTime, paused: video.paused, rate: video.playbackRate,
    duration: Number.isFinite(video.duration) ? video.duration : null, readyState: video.readyState, ended: video.ended });
  let timer;
  const report = () => {
    clearTimeout(timer);
    timer = setTimeout(() => send({ kind: 'candidates', candidates: [...elements].map(([media, { video }]) => {
      let url = null;
      try { const source = new URL(video.currentSrc); if (['http:', 'https:'].includes(source.protocol) && !source.username && !source.password && source.href.length <= 4096) url = source.href; } catch {}
      return { media, resource: video.currentSrc.slice(0, 4096), title: (video.getAttribute('aria-label') || video.title || document.title || location.hostname).slice(0, 256), url,
        duration: Number.isFinite(video.duration) ? video.duration : null };
    }) }), 80);
  };
  const discover = () => {
    for (const [source, child] of children) if (!child.element.isConnected) { children.delete(source); send({ kind: 'removed', removed: child.frame }); }
    for (const [id, entry] of elements) if (!entry.video.isConnected) { entry.lifetime.abort(); elements.delete(id); }
    for (const video of document.querySelectorAll('video')) {
      if (elements.size >= 64) break;
      if (ids.has(video) && elements.has(ids.get(video))) continue;
      const media = ids.get(video) || uuid(), lifetime = new AbortController();
      ids.set(video, media); elements.set(media, { video, lifetime });
      for (const event of ['emptied', 'loadstart']) video.addEventListener(event, report, { signal: lifetime.signal });
      for (const event of ['loadedmetadata', 'loadeddata', 'play', 'playing', 'pause', 'seeked', 'ratechange', 'ended', 'waiting', 'error']) {
        video.addEventListener(event, () => { send({ kind: 'sample', media, resource: video.currentSrc.slice(0, 4096), event }); if (event === 'loadedmetadata' || event === 'loadeddata') report(); }, { signal: lifetime.signal });
      }
    }
    report();
  };
  new MutationObserver(discover).observe(document, { childList: true, subtree: true });
  addEventListener('DOMContentLoaded', discover, { once: true });
  addEventListener('pagehide', () => send({ kind: 'candidates', candidates: [] }));
  addEventListener('message', async event => {
    const command = event.data;
    if (command?.bridge !== 'piik-page-command') return;
    for (const iframe of document.querySelectorAll('iframe')) iframe.contentWindow?.postMessage(command, '*');
    if (command.frame !== frame) return;
    const video = elements.get(command.media)?.video;
    if (!video?.isConnected) { send({ kind: 'reply', request: command.request, error: 'page_player_closed' }); return; }
    try {
      if (command.kind === 'patch') {
        const value = command.patch;
        if (value.position !== undefined) video.currentTime = value.position;
        if (value.rate !== undefined) video.playbackRate = value.rate;
        if (value.paused === true) video.pause();
        else if (value.paused === false) await video.play();
      }
      send({ kind: 'reply', request: command.request, state: state(video) });
    } catch (error) {
      const blocked = error?.name === 'NotAllowedError';
      if (blocked) send({ kind: 'blocked', media: command.media });
      send({ kind: 'reply', request: command.request, error: blocked ? 'watch_autoplay_blocked' : 'watch_media_failed' });
    }
  });
})();
