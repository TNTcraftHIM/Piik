// Run in a freshly opened local /film/ page using agent-browser eval --stdin.
// This exercises the real document/module; it does not mock its scene renderer.
// First click #language with agent-browser to grant native audio user activation.
(async () => {
  const assert = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  const el = (id) => document.getElementById(id);
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const settle = async () => {
    for (let i = 0; i < 4; i++) await nextFrame();
  };
  const until = async (test, message) => {
    const deadline = performance.now() + 6000;
    while (!test() && performance.now() < deadline) await nextFrame();
    assert(test(), message);
  };
  const media = el('soundtrack');
  const seek = (value) => {
    el('seek').value = String(value);
    el('seek').dispatchEvent(new Event('input'));
  };
  const position = () => Number(el('seek').value);
  const playing = () => document.body.hasAttribute('data-playing');
  const scene = () => [...document.querySelectorAll('#film-art > g')].filter((g) => g.style.display !== 'none').map((g) => g.id);
  const gamePose = () =>
    [...el('scene-game').children]
      .filter((g) => g.style.display !== 'none')
      .map((g) => g.outerHTML)
      .join('');
  assert(media && !media.getAttribute('src'), 'The poster must not request music');
  assert(!playing() && !el('curtain').hidden, 'The poster must wait for an explicit play action');
  assert(navigator.userActivation.hasBeenActive, 'Click #language with real browser input before running the audible check');

  el('start-muted').click();
  const deadline = performance.now() + 1500;
  while (position() < 0.02 && performance.now() < deadline) await nextFrame();
  assert(playing() && position() > 0, 'Muted playback must advance');
  assert(!media.getAttribute('src'), 'Muted playback must not request music');
  el('play').click();
  const paused = position();
  await settle();
  assert(position() === paused && !playing(), 'Pause must freeze the picture');

  // Seeking out of order and returning to a frame must produce the same pose.
  seek(20);
  const firstPose = gamePose();
  seek(40);
  assert(scene().includes('scene-people'), 'Seeking must select the correct scene');
  assert(document.querySelectorAll('[id^="seat-"]:not([id^="seat-row"]):not([id$="-eyes"])').length === 20, 'The room must have exactly twenty viewer figures');
  seek(68);
  assert(scene().includes('scene-end'), 'Seeking to the ending must render the ending');
  seek(20);
  assert(gamePose() === firstPose, 'Revisiting a frame must not depend on earlier scenes');
  for (const [time, name] of [
    [8, 'launch'],
    [15, 'share'],
    [33, 'invite'],
    [49, 'features'],
  ]) {
    seek(time);
    assert(scene().includes(`scene-${name}`), `The product sequence must show ${name}`);
  }
  const {BEAT,BAR} = await import('./score.js');
  seek(4.5 * BAR - .1);
  const beforeHandoff = el('ui-placement').transform.baseVal.consolidate().matrix;
  seek(4.5 * BAR + BEAT / 2);
  const afterHandoff = el('ui-placement').transform.baseVal.consolidate().matrix;
  assert(['a','b','c','d','e','f'].every(key=>Math.abs(beforeHandoff[key]-afterHandoff[key])<.01), 'The App window must stay in place between opening and choosing a screen');
  for (const [time, kind] of [
    [20, 'rpg'],
    [22, 'fps'],
    [24.5, 'platform'],
    [27, 'rts'],
    [29, 'moba'],
  ]) {
    seek(time);
    const shown = [...document.querySelectorAll('#scene-game > g[id^="montage-"]')].filter((g) => g.style.display !== 'none');
    assert(
      shown.some((g) => g.id === `montage-${kind}`),
      `The game montage must show ${kind}`,
    );
    assert(el('montage-cheer').style.opacity === '0', 'Applause must not precede the successful play');
  }
  seek(29.5);
  const health = () => new DOMMatrix(getComputedStyle(el('moba-health-0')).transform).a;
  assert(health() > 0 && el('montage-cheer').style.opacity === '0', 'The counterattack must leave time to see its target before the hit');
  seek(30.4);
  assert(
    health() === 0 && el('moba-result').style.opacity === '1',
    'The skill shot must resolve before celebrating',
  );
  assert(el('montage-cheer').style.opacity === '1', 'The reaction must follow the visible success');
  const finishPose = gamePose();
  seek(22);
  seek(30.4);
  assert(gamePose() === finishPose, 'Montage effects must remain deterministic after seeking backwards');
  const product = el('product-ui');
  assert(product.sandbox.value === 'allow-scripts' && product.hasAttribute('inert'), 'The demonstration must remain an isolated, non-interactive frame');
  seek(33);
  await settle();
  assert(
    !el('film-ui').hasAttribute('hidden') && el('ui-placement').getAttribute('transform').startsWith('matrix('),
    'The invitation must frame the shared product UI',
  );
  seek(49);
  assert(el('film-ui').hasAttribute('hidden'), 'The product UI must not cover other scenes');
  el('replay').click();
  await settle();
  assert(position() < 1 && playing() && scene().includes('scene-hello'), 'Replay must start a fresh film');
  seek(Number(el('seek').max));
  assert(!playing() && scene().includes('scene-end'), 'Seeking to the end must hold the ending');
  assert(el('time').textContent === '1:11 / 1:11', 'The player must format durations longer than one minute');

  // The language switch must preserve the frame and keep return links current.
  const beforeLanguage = document.documentElement.lang;
  el('language').click();
  assert(document.documentElement.lang !== beforeLanguage && scene().includes('scene-end'), 'Language changes must preserve playback position');
  assert(
    [...document.querySelectorAll('[data-home]')].every((a) => new URL(a.href).searchParams.get('lang') === document.documentElement.lang),
    'Return links must carry the current language',
  );
  el('language').click();
  assert(
    [...document.querySelectorAll('[data-home]')].every((a) => new URL(a.href).searchParams.get('lang') === beforeLanguage),
    'Return links must update on subsequent language changes',
  );

  // Rotated primary copy needs a safe frame, not just an overflow-free page.
  for (let language = 0; language < 2; language++) {
    for (const [time, selector] of [
      [1.4, '#hello-word text'], [4.3, '#discover-ticket text'],
      [8, '#launch-type text'], [15, '#share-type text'], [35, '#invite-type text'],
      [44, '#people-close-type text'], [46.5, '#free-type text'],
      [50, '#p2p-type text'], [54.5, '#encode-type text'],
      [58.3, '#more-game > g > text'], [60, '#more-art-type text'],
      [61.8, '#more-photos-type text'], [63.6, '#more-movie-type text'],
      [68, '#end-type text'],
    ]) {
      seek(time);
      for (const text of document.querySelectorAll(selector)) {
        const b = text.getBBox(), m = el('film-art').getCTM().inverse().multiply(text.getCTM());
        for (const [x,y] of [[b.x,b.y],[b.x+b.width,b.y],[b.x,b.y+b.height],[b.x+b.width,b.y+b.height]]) {
          const p = new DOMPoint(x,y).matrixTransform(m);
          assert(p.x >= 20 && p.x <= 1580 && p.y >= 20 && p.y <= 880, `Headline clipped: ${text.textContent}`);
        }
      }
    }
    el('language').click();
  }

  const bounds = (node) => {
    const b = node.getBBox(), m = el('film-art').getCTM().inverse().multiply(node.getCTM());
    const points = [[b.x,b.y],[b.x+b.width,b.y],[b.x,b.y+b.height],[b.x+b.width,b.y+b.height]]
      .map(([x,y]) => new DOMPoint(x,y).matrixTransform(m));
    return {left:Math.min(...points.map(p=>p.x)),right:Math.max(...points.map(p=>p.x))};
  };
  for (const [time,title,object] of [
    [50, 'p2p-type', '#p2p-source, #p2p-viewer'],
    [54.5, 'encode-type', '#encode-picture, #encode-audience'],
    [60, 'more-art-type', '#sketch-paper'],
    [61.8, 'more-photos-type', '#more-photos-picture svg > g'],
    [63.6, 'more-movie-type', '#movie-plane'],
  ]) {
    seek(time);
    for (const subject of document.querySelectorAll(object))
      assert(bounds(el(title)).right + 20 < bounds(subject).left, 'Scenario captions must leave room for their main object');
  }
  seek(50);
  const link = el('p2p-link'), length = link.getTotalLength();
  for (let i=0;i<=20;i++) {
    const point = link.getPointAtLength(length*i/20).matrixTransform(link.getScreenCTM());
    // The moving marker deliberately follows this line; SVG still hits it at opacity 0.
    const hit = document.elementsFromPoint(point.x,point.y).find(node=>!el('p2p-packet').contains(node));
    assert(hit===link, 'The direct connection arrow must remain fully visible between its windows');
  }
  seek(59.8);
  const sketchPose = () => el('sketch-paper').outerHTML + el('more-pencil').outerHTML;
  const firstSketch = sketchPose();
  seek(60.2);
  assert(sketchPose() !== firstSketch, 'The sketch must develop with the film clock');
  seek(20);
  seek(59.8);
  assert(sketchPose() === firstSketch, 'Sketch and pencil must survive seeking in either direction');

  // A separate instance makes the real staged controls observable, while the
  // presented film iframe keeps its opaque sandbox and non-interactive contract.
  const demo = document.createElement('iframe');
  let demoReady = false;
  const ready = event => { if (event.source===demo.contentWindow && event.data?.type==='piik-film-ui-ready') demoReady=true; };
  window.addEventListener('message',ready);
  demo.style.cssText = 'position:absolute;left:-10000px;width:1100px;height:740px';
  demo.src = new URL('./ui/index.html', location.href).href;
  document.body.append(demo);
  try {
    await until(() => demoReady, 'The staged UI must load');
    const doc = demo.contentDocument, win = demo.contentWindow;
    const at = async (scene,local,lang) => {
      win.postMessage({type:'piik-film-ui',scene,local,time:({launch:2,share:4.5,invite:13}[scene])*BAR+local,lang}, '*');
      await settle();
      const pointer = doc.getElementById('cursor'), box = pointer.getBoundingClientRect();
      return {x:box.x,y:box.y,pan:new DOMMatrix(doc.getElementById('camera').style.transform).f,visible:!pointer.hidden && Number(pointer.style.opacity)>.05};
    };
    for (const lang of ['zh-CN','en']) {
      await at('launch',9*BEAT,lang);
      assert(doc.querySelector('.lr-room') && doc.body.textContent.includes('9527'), 'Opening Piik must reveal the sample room before the next step');
      const beforeViewer = await at('invite',6*BEAT-1/60,lang);
      const afterViewer = await at('invite',6*BEAT+1/60,lang);
      assert(Math.abs(beforeViewer.pan-afterViewer.pan)<2, 'The camera must return smoothly before the viewer joins');
      for (const [scene,beat,selector] of [
        ['launch',3,'[role="radio"]'], ['launch',8,'button[type="submit"]'],
        ['share',2,'.lr-entry-action button'], ['share',6,'.lr-source-option'],
        ['invite',3,'.lr-invite-url'],
      ]) {
        const p = await at(scene,beat*BEAT,lang);
        const element = doc.querySelectorAll(selector)[selector==='[role="radio"]'?1:0];
        const target = scene==='invite' ? element.closest('.lr-row').querySelector('button') : element;
        const b = target.getBoundingClientRect();
        assert(p.visible && p.x>=b.left && p.x<=b.right && p.y>=b.top && p.y<=b.bottom, 'Clicks must land on visible controls');
      }
      for (const [scene,moment] of [
        ['launch',3.25*BEAT], ['launch',4*BEAT], ['launch',3.8],
        ['share',2.25*BEAT], ['share',3*BEAT], ['share',2.1], ['invite',3.25*BEAT],
      ]) {
        let previous;
        for (const offset of [-2,-1,0,1,2]) {
          const p = await at(scene,moment+offset/60,lang);
          assert(p.visible, 'The cursor must remain visible across a target or state change');
          if (previous) assert(Math.hypot(p.x-previous.x,p.y-previous.y)<30, 'The cursor must not teleport between controls');
          previous=p;
        }
        await at('launch',0,lang);
        const revisited=await at(scene,moment+2/60,lang);
        assert(Math.hypot(revisited.x-previous.x,revisited.y-previous.y)<.01, 'Cursor paths must not depend on playback history');
      }
    }
  } finally { window.removeEventListener('message',ready); demo.remove(); }

  el('capture').click();
  await settle();
  assert(document.body.classList.contains('fullscreen') && el('transport').checkVisibility(), 'Fullscreen must retain touch playback controls');
  const exitBounds = el('capture').getBoundingClientRect();
  assert(exitBounds.top >= 0 && exitBounds.bottom <= innerHeight, 'Exit fullscreen must remain within reach');
  el('capture').click();
  await settle();
  assert(!document.body.classList.contains('fullscreen'), 'The fullscreen button must also exit');

  // The README img uses native SVG/CSS, not the film's JavaScript renderer.
  // Check shared poses at sampled frames and that only one activity is visible.
  const hero = document.createElement('iframe');
  hero.style.cssText = 'position:absolute;left:-10000px;width:900px;height:590px';
  const loaded = new Promise(resolve => { hero.onload = resolve; });
  hero.src = new URL('../assets/living-room.svg', location.href).href;
  document.body.append(hero);
  try {
    await loaded;
    const {HERO_KINDS,HERO_CUT,heroFrame} = await import('../assets/activities.js');
    const doc = hero.contentDocument, win = hero.contentWindow;
    assert(!doc.getElementById('montage-cheer'), 'The homepage and README hero must omit the film reaction caption');
    const animations = doc.getAnimations();
    assert(animations.length > 0, 'Run this check with normal motion enabled');
    for (const [index,kind] of HERO_KINDS.entries()) {
      for (const animation of animations) { animation.pause(); animation.currentTime = (index+.5)*HERO_CUT*1000; }
      const shown = HERO_KINDS.filter(name=>win.getComputedStyle(doc.getElementById('activity-'+name)).opacity==='1');
      assert(shown.length===1 && shown[0]===kind, `The hero must show only ${kind}`);
      assert(win.getComputedStyle(doc.getElementById('hero-gamepad')).opacity===(kind==='rpg'?'1':'0'), 'The gamepad must match the activity');
      for (const [id,style] of Object.entries(heroFrame(kind,.5))) {
        const actual = win.getComputedStyle(doc.getElementById(id));
        if (style.opacity !== undefined) assert(Math.abs(Number(actual.opacity)-Number(style.opacity))<.01, `Hero visibility differs: ${id}`);
        if (style.transform) {
          const a=new DOMMatrix(actual.transform), b=new DOMMatrix(style.transform);
          assert(['a','b','c','d','e','f'].every(key=>Math.abs(a[key]-b[key])<.03), `Hero pose differs: ${id}`);
        }
      }
    }
    for(const time of Array.from({length:HERO_KINDS.length+1},(_,i)=>i*HERO_CUT*1000)) {
      for(const animation of animations) animation.currentTime=time;
      const shown=HERO_KINDS.filter(kind=>win.getComputedStyle(doc.getElementById('activity-'+kind)).opacity==='1');
      assert(shown.length===1 && shown[0]===HERO_KINDS[(time/(HERO_CUT*1000))%HERO_KINDS.length], 'Hero cuts must not show a blank or overlapping frame');
    }
    win.location.hash='still';
    await settle();
    assert(doc.getAnimations().length===0, 'The still image must stop every decorative animation');
    assert(win.getComputedStyle(doc.getElementById('activity-rpg')).opacity==='1', 'The still image must retain a useful game scene');
  } finally { hero.remove(); }

  // Use the real audio element and server: a muted-only check misses broken
  // byte-range hosting that resets the film to zero while scrubbing with sound.
  seek(2);
  el('sound').click();
  el('play').click();
  await until(() => !media.paused && media.currentTime >= 2, 'The soundtrack must start at the selected position');
  for (const target of [25, 8, 41]) {
    seek(target);
    await until(() => !media.seeking && media.currentTime >= target, 'Audible seeking must reach the selected position');
    assert(media.currentTime < target + 1 && playing(), 'Audible seeking must continue from the selected position');
  }
  el('play').click();
  seek(17);
  el('play').click();
  await until(() => !media.seeking && media.currentTime >= 17, 'A paused seek must resume at the selected position');
  assert(media.currentTime < 18, 'Resume must not return to the previous audio position');
  el('play').click();
  el('sound').click();

  // Hold two native play promises: a cancelled attempt must not mute its successor.
  const nativePlay = media.play;
  const pending = [];
  Object.defineProperty(media, 'paused', {
    configurable: true,
    get: () => false,
  });
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
    media.currentTime = Number(el('seek').max) - 0.005;
    media.dispatchEvent(new Event('ended'));
    pending[2].resolve();
    await settle();
    assert(!playing() && position() === Number(el('seek').max), 'Native audio ending must hold the final frame');
    assert(el('sound').getAttribute('aria-pressed') === 'true', 'Finishing the soundtrack must preserve sound for replay');
    el('replay').click();
    Object.defineProperty(media, 'paused', {
      configurable: true,
      get: () => true,
    });
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
  return {
    passed: [
      'lazy audio',
      'muted play',
      'pause',
      'seek/replay determinism',
      'game montage and reaction timing',
      'bilingual headline bounds',
      'scenario composition and seekable sketch',
      'continuous cursor paths, click targets and reverse seeking',
      'standalone hero montage, shared poses and still image',
      'isolated product sequence',
      'touch-accessible fullscreen',
      'native audible seek/resume',
      'twenty viewers',
      'end hold and minute formatting',
      'language round trip',
      'stale play rejection',
      'audio failure',
      'native ending',
      'native media pause',
      'page width',
    ],
  };
})();
