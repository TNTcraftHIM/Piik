// Run in a freshly opened local /film/ page using agent-browser eval --stdin.
// This exercises the real document/module; it does not mock its scene renderer.
(async () => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const el = (id) => document.getElementById(id);
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const settle = async () => { await nextFrame(); await nextFrame(); };
  const media = el('soundtrack');
  const seek = (value) => { el('seek').value = String(value); el('seek').dispatchEvent(new Event('input')); };
  const position = () => Number(el('seek').value);
  const playing = () => document.body.hasAttribute('data-playing');
  const scene = () => [...document.querySelectorAll('#film-art > g')].filter((g) => g.style.display !== 'none').map((g) => g.id);
  assert(media && !media.getAttribute('src'), 'The poster must not request music');
  assert(!playing() && !el('curtain').hidden, 'The poster must wait for an explicit play action');

  el('start-muted').click();
  const deadline = performance.now() + 1500;
  while (position() < .02 && performance.now() < deadline) await nextFrame();
  assert(playing() && position() > 0, 'Muted playback must advance');
  assert(!media.getAttribute('src'), 'Muted playback must not request music');
  el('play').click();
  const paused = position();
  await settle();
  assert(position() === paused && !playing(), 'Pause must freeze the picture');

  // Seeking out of order and returning to a frame must produce the same pose.
  seek(10);
  const firstPose = el('scene-game').outerHTML;
  seek(23);
  assert(scene().includes('scene-people'), 'Seeking must select the correct scene');
  assert(document.querySelectorAll('[id^="seat-"]:not([id^="seat-row"]):not([id$="-eyes"])').length === 20, 'The room must have exactly twenty viewer figures');
  seek(37);
  assert(scene().includes('scene-end'), 'Seeking to the ending must render the ending');
  seek(10);
  assert(el('scene-game').outerHTML === firstPose, 'Revisiting a frame must not depend on earlier scenes');
  el('replay').click();
  await settle();
  assert(position() < 1 && playing() && scene().includes('scene-hello'), 'Replay must start a fresh film');
  seek(Number(el('seek').max));
  assert(!playing() && scene().includes('scene-end'), 'Seeking to the end must hold the ending');

  // The language switch must preserve the frame and keep return links current.
  const beforeLanguage = document.documentElement.lang;
  el('language').click();
  assert(document.documentElement.lang !== beforeLanguage && scene().includes('scene-end'), 'Language changes must preserve playback position');
  assert([...document.querySelectorAll('[data-home]')].every((a) => new URL(a.href).searchParams.get('lang') === document.documentElement.lang), 'Return links must carry the current language');
  el('language').click();
  assert([...document.querySelectorAll('[data-home]')].every((a) => new URL(a.href).searchParams.get('lang') === beforeLanguage), 'Return links must update on subsequent language changes');

  // Hold two native play promises: a cancelled attempt must not mute its successor.
  const nativePlay = media.play;
  const pending = [];
  Object.defineProperty(media, 'paused', { configurable: true, get: () => false });
  media.play = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  try {
    seek(2);
    el('sound').click();
    el('play').click();
    assert(pending.length === 1, 'An audible start must call native play');
    el('play').click();
    el('play').click();
    assert(pending.length === 2, 'A new start must own its own play result');
    pending[0].reject(new DOMException('Cancelled', 'AbortError'));
    await settle();
    assert(playing() && el('sound').getAttribute('aria-pressed') === 'true', 'A stale rejection must not mute current playback');
    pending[1].reject(new DOMException('Blocked', 'NotAllowedError'));
    await settle();
    assert(playing() && el('sound').getAttribute('aria-pressed') === 'false', 'A current audio failure must continue the visual film');
    assert(el('player-status').textContent.length > 0, 'An audio failure must be explained');
    el('play').click();
    el('sound').click();
    el('replay').click();
    media.currentTime = Number(el('seek').max) - .005;
    media.dispatchEvent(new Event('ended'));
    pending[2].resolve();
    await settle();
    assert(!playing() && position() === Number(el('seek').max), 'Native audio ending must hold the final frame');
    assert(el('sound').getAttribute('aria-pressed') === 'true', 'Finishing the soundtrack must preserve sound for replay');
    el('replay').click();
    Object.defineProperty(media, 'paused', { configurable: true, get: () => true });
    media.dispatchEvent(new Event('pause'));
    pending[3].resolve();
    await settle();
    const playLabel = document.documentElement.lang === 'zh-CN' ? '播放' : 'Play';
    assert(!playing() && el('play').getAttribute('aria-label') === playLabel, 'Native media pause must pause the picture and its controls');
  } finally {
    media.play = nativePlay;
    delete media.paused;
    if (playing()) el('play').click();
    media.pause();
  }
  assert(document.documentElement.scrollWidth <= innerWidth, 'The page must not overflow horizontally');
  return { passed: ['lazy audio', 'muted play', 'pause', 'seek/replay determinism', 'twenty viewers', 'end hold', 'language round trip', 'stale play rejection', 'audio failure', 'native ending', 'native media pause', 'page width'] };
})()
