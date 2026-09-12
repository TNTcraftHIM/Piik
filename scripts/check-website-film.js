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
    [7, 'website'],
    [9.8, 'desktop'],
    [12, 'launch'],
    [15, 'share'],
    [33, 'invite'],
    [49, 'features'],
  ]) {
    seek(time);
    assert(scene().includes(`scene-${name}`), `The product sequence must show ${name}`);
  }
  const {BEAT,BAR,DOWNLOAD_AT,DURATION} = await import('./score.js');
  for (const [bar, feature] of [[19.5, 'free'], [20.5, 'p2p'], [21.5, 'encode'], [23, 'devices']]) {
    seek(bar * BAR);
    const visible = [...el('scene-features').children].filter(node => node.style.display !== 'none');
    assert(visible.length === 1 && visible[0].id === `feature-${feature}`, 'The four benefits must advance within the same musical phrase');
  }
  seek(22.5 * BAR + BEAT / 2);
  const devices = () => ['laptop', 'tablet', 'phone'].map(id => el(`devices-${id}`).outerHTML).join('');
  const arrivingDevices = devices();
  seek(23.5 * BAR);
  assert(devices() !== arrivingDevices && ['laptop', 'tablet', 'phone'].every(id => el(`devices-${id}`).getAttribute('opacity') === '1'), 'The devices must enter in sequence and settle into a readable frame');
  seek(22.5 * BAR + BEAT / 2);
  assert(devices() === arrivingDevices, 'Device arrival must be deterministic after reverse seeking');
  for (const bar of [3.5, 4.5, 6]) {
    seek(bar * BAR - .1);
    const beforeHandoff = el('ui-placement').transform.baseVal.consolidate().matrix;
    seek(bar * BAR + BEAT / 2);
    const afterHandoff = el('ui-placement').transform.baseVal.consolidate().matrix;
    assert(['a','b','c','d','e','f'].every(key=>Math.abs(beforeHandoff[key]-afterHandoff[key])<.01), 'The desktop, App and source steps must keep a continuous window position');
  }
  const gameKinds = ['rpg', 'fps', 'platform', 'rts', 'moba', 'fighting'];
  const gameCut = 5 * BAR / gameKinds.length;
  for (const [index, kind] of gameKinds.entries()) {
    seek(8 * BAR + (index + .35) * gameCut);
    const shown = [...document.querySelectorAll('#scene-game > g[id^="montage-"]')].filter((g) => g.style.display !== 'none');
    assert(
      shown.some((g) => g.id === `montage-${kind}`),
      `The game montage must show ${kind}`,
    );
    assert(el('montage-cheer').style.opacity === '0', 'Applause must not precede the successful play');
  }
  assert(!document.querySelector('#montage-label, [id^="montage-kind-"], [id^="fps-count-"]'), 'The games must read through their action without category or practice labels');
  for (const [index, shot] of [.55, 1.1, 1.65].entries()) {
    const at = local => seek(8 * BAR + gameCut * (1 + local / BAR));
    at(shot - .04);
    const aim = el('fps-tool').style.transform;
    at(shot + .025);
    assert(Number(el('fps-muzzle').style.opacity) > 0 && Number(el('fps-tracer').style.opacity) > 0 && el('fps-tool').style.transform !== aim, 'The foreground weapon must fire and recoil toward its crosshair');
    at(shot + .19);
    assert(el(`fps-target-${index}`).style.opacity === '0' && el('fps-muzzle').style.opacity === '0', 'Each shot must leave a clear hit after the flash');
  }
  seek(8 * BAR + 4.5 * gameCut);
  const health = () => new DOMMatrix(getComputedStyle(el('moba-health-0')).transform).a;
  assert(health() > 0 && el('montage-cheer').style.opacity === '0', 'The counterattack must leave time to see its target before the hit');
  seek(8 * BAR + 4.85 * gameCut);
  assert(
    health() === 0 && el('moba-result').style.opacity === '1',
    'The skill shot must resolve before celebrating',
  );
  seek(8 * BAR + 5.48 * gameCut);
  const fighterHealth = () => new DOMMatrix(getComputedStyle(el('fighting-health')).transform).a;
  assert(fighterHealth() > 0 && el('montage-cheer').style.opacity === '0', 'The guard must leave time to see the counterattack before the hit');
  const finalHit = 8 * BAR + 5.85 * gameCut;
  seek(finalHit);
  assert(fighterHealth() === 0 && el('montage-cheer').style.opacity === '1', 'The reaction must follow the successful counterattack');
  const finishPose = gamePose();
  seek(22);
  seek(finalHit);
  assert(gamePose() === finishPose, 'Montage effects must remain deterministic after seeking backwards');
  const product = el('product-ui');
  assert([product, el('website-ui')].every(frame => frame.sandbox.value === 'allow-scripts' && frame.hasAttribute('inert')), 'Both real pages must remain isolated, non-interactive frames');
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
  assert(!playing() && scene().includes('scene-end') && el('download-banner').style.display !== 'none', 'Seeking to the end must hold the download overlay on the original ending');
  assert(el('time').textContent === '1:16 / 1:16', 'The player must format durations longer than one minute');
  assert(!el('download').hidden && new URL(el('download').href).hash === '#download' && el('download').target === '_top', 'The final action must reach the homepage downloads, including from the embedded player');
  const endingPose = () => el('scene-end').outerHTML;
  const lastPose = endingPose();
  seek(DOWNLOAD_AT-BEAT);
  assert(el('download').hidden, 'Rewinding must hide the ending action');
  seek(DURATION - 3 * BEAT);
  const endingAnimations = () => el('end-tv').getAnimations({subtree:true});
  assert(endingAnimations().length === 5 && endingAnimations().every(animation => animation.playState === 'paused' && animation.effect.getTiming().duration === 3600), 'The ending must reuse the loading mascot loop, held at the requested film frame');
  assert(getComputedStyle(el('end-tv-wink')).opacity === '1' && Number(getComputedStyle(el('end-tv-sparkles').firstElementChild).opacity) > .5, 'The loading mascot must wink with its gold sparkles');
  for (const time of [DURATION - BEAT / 2, DURATION - 1 / 60]) {
    seek(time);
    assert(getComputedStyle(el('end-tv-wink')).opacity === '0' && getComputedStyle(el('end-tv-open')).opacity === '1' && [...el('end-tv-sparkles').children].every(star => getComputedStyle(star).opacity === '0'), 'The final wink and both sparkles must settle before the music and last exported frame');
  }
  assert(!el('scene-download') && el('download-banner').closest('#scene-end') && el('end-brand').checkVisibility(), 'The download must overlay the existing brand and room instead of starting another scene');
  seek(Number(el('seek').max));
  assert(endingPose() === lastPose, 'The final pose must survive reverse seeking');
  const endingPhase = endingAnimations().map(animation => animation.currentTime);
  seek(DURATION - .1);
  el('play').click();
  await until(() => !playing(), 'The film must finish naturally');
  await settle();
  assert(endingAnimations().every(animation => animation.playState === 'running'), 'Natural completion must leave only the mascot idle loop running');
  assert(endingAnimations().every((animation, index) => animation.currentTime >= endingPhase[index] && animation.currentTime < endingPhase[index] + 250), 'Natural completion must continue the same phase without restarting the wink');
  seek(DURATION);
  const frozenEnding = endingAnimations().map(animation => animation.currentTime);
  await settle();
  assert(endingAnimations().every((animation, index) => animation.playState === 'paused' && animation.currentTime === frozenEnding[index]), 'Seeking after completion must freeze the mascot again');
  seek(DOWNLOAD_AT + BAR);
  el('play').click();
  el('download').addEventListener('click', event => event.preventDefault(), {once:true});
  el('download').click();
  assert(!playing() && media.paused, 'The ending action must pause playback before navigation');
  seek(Number(el('seek').max));

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
  const previousTheme = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = 'dark';
  el('language').click();
  delete document.documentElement.dataset.theme;
  el('language').click();
  assert([...document.querySelectorAll('[data-home]')].every(a => !new URL(a.href).searchParams.has('theme')), 'Returning to system theme must clear the old explicit theme from links');
  if (previousTheme) document.documentElement.dataset.theme = previousTheme;
  el('language').click();
  el('language').click();

  // Rotated primary copy needs a safe frame, not just an overflow-free page.
  for (let language = 0; language < 2; language++) {
    for (const [time, selector] of [
      [1.4, '#hello-word text'], [4.3, '#discover-ticket text'],
      [7, '#website-type text'], [9.8, '#desktop-type text'],
      [12, '#launch-type text'], [15, '#share-type text'], [35, '#invite-type text'],
      [44, '#people-close-type text'], [46.5, '#free-type text'],
      [48.8, '#p2p-type text, #feature-p2p > text'], [52, '#encode-type text, #feature-encode > text'],
      [55.5, '#devices-type text, #feature-devices > text'],
      [58.3, '#more-game > g > text'], [60, '#more-art-type text'],
      [61.8, '#more-photos-type text'], [63.6, '#more-movie-type text'],
      [68, '#end-type text'], [71.5, '#download-banner text'],
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
    // Stable corner labels share a baseline even when nearby artwork moves.
    for (const [time, selector] of [
      [1.4, '#hello-label'], [4.3, '#discover-label'],
      [7, '#scene-website'], [9.8, '#scene-desktop'], [12, '#scene-launch'],
      [15, '#share-label'], [17.9, '#share-label'], [35, '#scene-invite'],
      [40, '#scene-people'], [44, '#people-close'], [46.5, '#feature-free'],
      [48.8, '#feature-p2p'], [52, '#feature-encode'], [55.5, '#feature-devices'],
      [58.3, '#more-game'], [60, '#more-art'], [61.8, '#more-photos'],
      [63.6, '#more-movie'], [68, '#end-label'], [71.5, '#end-label'],
    ]) {
      seek(time);
      const label = document.querySelector(`${selector} > .scene-label`);
      const matrix = el('film-art').getCTM().inverse().multiply(label.getCTM());
      const baseline = label.getStartPositionOfChar(0).matrixTransform(matrix);
      const style = getComputedStyle(label);
      assert(Math.abs(baseline.x-64)<.01 && Math.abs(baseline.y-64)<.01, `Scene label moved: ${label.textContent}`);
      assert(Math.abs(matrix.a-1)<.01 && Math.abs(matrix.b)<.01 && Math.abs(matrix.c)<.01 && Math.abs(matrix.d-1)<.01, `Scene label rotated or scaled: ${label.textContent}`);
      assert(style.fontSize==='19px' && style.fontWeight==='650' && Math.abs(parseFloat(style.letterSpacing)-1.9)<.01, `Scene label typography differs: ${label.textContent}`);
    }
    el('language').click();
  }

  const bounds = (node) => {
    const b = node.getBBox(), m = el('film-art').getScreenCTM().inverse().multiply(node.getScreenCTM());
    const points = [[b.x,b.y],[b.x+b.width,b.y],[b.x,b.y+b.height],[b.x+b.width,b.y+b.height]]
      .map(([x,y]) => new DOMPoint(x,y).matrixTransform(m));
    return {left:Math.min(...points.map(p=>p.x)),right:Math.max(...points.map(p=>p.x))};
  };
  for (const [time,title,object] of [
    [48.8, 'p2p-type', '#p2p-source, #p2p-viewer'],
    [52, 'encode-type', '#encode-picture, #encode-audience'],
    [55.5, 'devices-type', '#devices-laptop, #devices-tablet, #devices-phone'],
    [60, 'more-art-type', '#sketch-paper'],
    // The card frames bound the visible crop; nested scenery extends behind it.
    [61.8, 'more-photos-type', '#more-photos-picture > svg > g > rect'],
    [63.6, 'more-movie-type', '#movie-answer-machine'],
  ]) {
    seek(time);
    for (const subject of document.querySelectorAll(object))
      assert(bounds(el(title)).right + 20 < bounds(subject).left, `Scenario caption must leave room for its main object: ${title}`);
  }
  seek(48.8);
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
  const websiteDemo = document.createElement('iframe');
  let demoReady = false, websiteReady = false;
  const ready = event => {
    if (event.data?.type !== 'piik-film-ui-ready') return;
    if (event.source===demo.contentWindow) demoReady=true;
    if (event.source===websiteDemo.contentWindow) websiteReady=true;
  };
  window.addEventListener('message',ready);
  demo.style.cssText = 'position:absolute;left:-10000px;width:1100px;height:740px';
  demo.src = new URL('./ui/index.html', location.href).href;
  websiteDemo.style.cssText = demo.style.cssText;
  websiteDemo.src = new URL('./ui/website.html', location.href).href;
  document.body.append(demo, websiteDemo);
  try {
    await until(() => demoReady && websiteReady, 'The staged App and actual homepage must load');
    const doc = demo.contentDocument, win = demo.contentWindow;
    const at = async (scene,local,lang) => {
      const frame = {type:'piik-film-ui',scene,local,time:({website:2,desktop:3.5,launch:4.5,share:6,invite:13}[scene])*BAR+local,lang};
      const target = scene === 'website' ? websiteDemo : demo;
      target.contentWindow.postMessage(frame, '*');
      await settle();
      const pointer = target.contentDocument.getElementById('cursor'), box = pointer.getBoundingClientRect();
      return {x:box.x,y:box.y,pan:scene==='website'?0:new DOMMatrix(doc.getElementById('camera').style.transform).f,visible:!pointer.hidden && Number(pointer.style.opacity)>.05};
    };
    for (const lang of ['zh-CN','en']) {
      await at('website',0,lang);
      const homepage = websiteDemo.contentDocument;
      assert(homepage.documentElement.lang === lang && homepage.defaultView.scrollY === 0, 'The opening must show the actual homepage in the film language');
      const downloaded = await at('website',4.5*BEAT,lang);
      const downloadButton = homepage.querySelector('#download .download-button').getBoundingClientRect();
      assert(homepage.defaultView.scrollY > 1000 && downloaded.visible &&
        downloaded.x >= downloadButton.left && downloaded.x <= downloadButton.right &&
        downloaded.y >= downloadButton.top && downloaded.y <= downloadButton.bottom && downloadButton.bottom < 740,
        'The website must scroll to a visible system download button before clicking');
      await at('website',0,lang);
      const downloadedAgain = await at('website',4.5*BEAT,lang);
      assert(Math.hypot(downloadedAgain.x-downloaded.x, downloadedAgain.y-downloaded.y)<.01, 'The website scroll and click must survive reverse seeking');
      await at('launch',5*BEAT,lang);
      assert(doc.querySelector('.lr-room') && doc.body.textContent.includes('9527'), 'Opening Piik must reveal the sample room before the next step');
      await at('invite',4.5*BEAT,lang);
      assert(doc.querySelector('#chat-draft').value.includes('/r/9527') && doc.querySelector('.film-chat'), 'The invite must be pasted into an external chat example');
      await at('invite',7*BEAT,lang);
      assert(doc.querySelector('.chat-mine').textContent.includes('/r/9527') && !doc.querySelector('#chat-draft').value, 'The chat must show the sent link before friends enter');
      const beforeViewer = await at('invite',8*BEAT-1/60,lang);
      const afterViewer = await at('invite',8*BEAT+1/60,lang);
      assert(Math.abs(beforeViewer.pan-afterViewer.pan)<2, 'The camera must return smoothly before the viewer joins');
      for (const [scene,beat,selector] of [
        ['desktop',2.5,'#desktop-app'],
        ['launch',1.5,'[role="radio"]'], ['launch',4,'button[type="submit"]'],
        ['share',1.5,'.lr-entry-action button'], ['share',4,'.lr-source-option'],
        ['invite',1.5,'.lr-invite-url'], ['invite',4,'#chat-draft'], ['invite',6,'#chat-send'],
      ]) {
        const p = await at(scene,beat*BEAT,lang);
        const element = doc.querySelectorAll(selector)[selector==='[role="radio"]'?1:0];
        const target = selector==='.lr-invite-url' ? element.closest('.lr-row').querySelector('button') : element;
        const b = target.getBoundingClientRect();
        assert(p.visible && p.x>=b.left && p.x<=b.right && p.y>=b.top && p.y<=b.bottom, 'Clicks must land on visible controls');
      }
      for (const [scene,moment] of [
        ['launch',1.75*BEAT], ['launch',2*BEAT], ['launch',3.5*BEAT],
        ['share',1.75*BEAT], ['share',2.25*BEAT], ['share',3.5*BEAT],
        ['invite',1.75*BEAT], ['invite',3*BEAT], ['invite',4*BEAT], ['invite',4.5*BEAT], ['invite',6.25*BEAT],
      ]) {
        let previous;
        for (const offset of [-2,-1,0,1,2]) {
          const p = await at(scene,moment+offset/60,lang);
          assert(p.visible, `The cursor must remain visible across ${scene} at ${moment.toFixed(3)}s (${offset} frames)`);
          if (previous) assert(Math.hypot(p.x-previous.x,p.y-previous.y)<30, 'The cursor must not teleport between controls');
          previous=p;
        }
        await at('launch',0,lang);
        const revisited=await at(scene,moment+2/60,lang);
        assert(Math.hypot(revisited.x-previous.x,revisited.y-previous.y)<.01, 'Cursor paths must not depend on playback history');
      }
    }
  } finally { window.removeEventListener('message',ready); demo.remove(); websiteDemo.remove(); }

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
      assert(win.getComputedStyle(doc.getElementById('hero-gamepad')).opacity==='1' && doc.querySelectorAll('#hero-gamepad .game-hand').length===2, 'The original controller and floating hands must stay visible throughout the activity loop');
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
      'bilingual scene label alignment',
      'four benefit cuts and seekable device arrivals',
      'scenario composition and seekable sketch',
      'website download, desktop launch, chat sending and continuous cursor paths',
      'standalone hero montage, shared poses and still image',
      'isolated product sequence',
      'touch-accessible fullscreen',
      'native audible seek/resume',
      'twenty viewers',
      'download overlay, shared mascot idle/pause/seek and minute formatting',
      'download pause and preference round trip',
      'language round trip',
      'stale play rejection',
      'audio failure',
      'native ending',
      'native media pause',
      'page width',
    ],
  };
})();
