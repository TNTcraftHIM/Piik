import { bindSvgReplayOnPointerEnter, replaySvgAnimations } from '../../src/client/ui/animation.ts';

// The TV character geometry for the website game, film and demonstration scenes.
export function mascotMarkup(id, fill = 'none', animated = false) {
  const part = animated ? 'lr-brand' : 'mascot';
  return `<g fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <g class="${part}-shell"><rect${animated ? ' class="lr-brand-frame"' : ''} pathLength="1" x="4" y="8" width="24" height="18" rx="4" fill="${fill}"/>
      ${animated ? '<g class="lr-brand-antenna-motion">' : ''}<path class="${part}-antenna" pathLength="1" d="m11 4 5 4 5-4"/>${animated ? '</g>' : ''}
      <path class="${part}-feet" pathLength="1" d="M10 29l2-3m10 3-2-3"/></g>
    <g id="${id}-eyes" class="${part}-face">
      <circle cx="11.5" cy="16.5" r="1.25" fill="currentColor" stroke="none"/>
      <circle id="${id}-open" class="${part}-eye-open" cx="21.35" cy="16.5" r="1.25" fill="currentColor" stroke="none" opacity="0"/>
      <path id="${id}-wink" class="${part}-eye-wink" pathLength="1" d="M19 17c1.5-1.8 3.2-1.8 4.7 0"/>
    </g>
    <g id="${id}-sparkles" class="${part}-sparkles" stroke="#d7982b" stroke-width="1.2" fill="#f4c14d" opacity="0">
      <path d="m25 11.5 .8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8.8-1.9Z"/>
      <path d="m25 17.2 .45 1.1 1.1.45-1.1.45-.45 1.1-.45-1.1-1.1-.45 1.1-.45.45-1.1Z"/>
    </g></g>`;
}

// The Silip mark; BrandMark.tsx owns the same geometry for the App and Browser UI.
export function brandMarkup(id) {
  const pupils = `${id}-pupils`;
  return `<svg class="mascot lr-brand-mark is-once is-drawing" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <mask id="${pupils}" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32"><rect width="32" height="32" fill="#fff"/>
      <g class="lr-brand-pupils" fill="#000"><circle cx="12.4" cy="9.1" r="1.4"/><circle cx="22.4" cy="9.1" r="1.4"/></g></mask>
    <g class="lr-brand-shell" stroke-width="4.2"><path class="lr-brand-stem" pathLength="1" d="M11 24.5V16.2"/><path class="lr-brand-stem" pathLength="1" d="M21 24.5V16.2"/></g>
    <g class="lr-brand-face" mask="url(#${pupils})" fill="currentColor" stroke="none"><circle class="lr-brand-eye" cx="11" cy="9" r="3.5"/><circle class="lr-brand-eye" cx="21" cy="9" r="3.5"/></g>
    <g class="lr-brand-sparkles" stroke-width="1.6"><path pathLength="1" d="m27.6 2.4 .7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7.7-1.6Z"/><path pathLength="1" d="m28.6 8.6 .4 .9 .9 .4-.9 .4-.4 .9-.4-.9-.9-.4 .9-.4.4-.9Z"/></g>
  </svg><span>Silip</span>`;
}

export function bindBrandMotion(graphic) {
  const lastStem = graphic.querySelector('.lr-brand-stem:last-child');
  const finishDrawing = event => {
    if (event.animationName === 'lr-brand-draw') graphic.classList.remove('is-drawing');
  };
  lastStem.addEventListener('animationend', finishDrawing);
  const beginDrawing = () => {
    graphic.classList.add('is-drawing');
    // Commit the hidden gesture before restarting the drawing timeline.
    void graphic.getBoundingClientRect();
  };
  const stopReplay = bindSvgReplayOnPointerEnter(graphic, beginDrawing);
  // SSR may finish drawing before hydration attaches the completion listener.
  beginDrawing();
  replaySvgAnimations(graphic);
  return () => {
    lastStem.removeEventListener('animationend', finishDrawing);
    stopReplay();
  };
}

export function mountBrands() {
  document.querySelectorAll('[data-brand]').forEach((link, index) => {
    link.innerHTML = brandMarkup(`brand-${index}`);
    bindBrandMotion(link.querySelector('.lr-brand-mark'));
  });
}
