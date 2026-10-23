// Shared geometry for the website, film and original demonstration scenes.
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

export function brandMarkup(id) {
  return `<svg class="mascot lr-brand-mark is-once is-drawing" viewBox="0 0 32 32" aria-hidden="true">${mascotMarkup(id, 'none', true)}</svg><span>Piik<span class="identity-dot">.</span></span>`;
}

export function mountBrands() {
  document.querySelectorAll('[data-brand]').forEach((link, index) => {
    link.innerHTML = brandMarkup(`brand-${index}`);
    const graphic = link.querySelector('.lr-brand-mark');
    graphic.querySelector('.lr-brand-feet').addEventListener('animationend', event => {
      if (event.animationName === 'lr-brand-draw') graphic.classList.remove('is-drawing');
    });
    const replay = () => {
      graphic.classList.add('is-drawing');
      // Commit the hidden gesture before restarting the drawing timeline.
      void graphic.getBoundingClientRect();
      graphic.getAnimations({ subtree: true }).forEach(animation => { animation.currentTime = 0; });
    };
    link.addEventListener('pointerenter', replay);
    link.addEventListener('focus', replay);
  });
}
