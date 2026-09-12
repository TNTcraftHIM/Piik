// Shared geometry for the website, film and original demonstration scenes.
export function mascotMarkup(id, fill = 'none') {
  return `<g fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <g class="mascot-shell"><rect pathLength="1" x="4" y="8" width="24" height="18" rx="4" fill="${fill}"/>
      <path class="mascot-antenna" pathLength="1" d="m11 4 5 4 5-4"/>
      <path class="mascot-feet" pathLength="1" d="M10 29l2-3m10 3-2-3"/></g>
    <g id="${id}-eyes" class="mascot-face">
      <circle cx="11.5" cy="16.5" r="1.25" fill="currentColor" stroke="none"/>
      <circle id="${id}-open" class="mascot-eye-open" cx="21.35" cy="16.5" r="1.25" fill="currentColor" stroke="none" opacity="0"/>
      <path id="${id}-wink" class="mascot-eye-wink" pathLength="1" d="M19 17c1.5-1.8 3.2-1.8 4.7 0"/>
    </g>
    <g id="${id}-sparkles" class="mascot-sparkles" stroke="#d7982b" stroke-width="1.2" fill="#f4c14d" opacity="0">
      <path d="m25 11.5 .8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8.8-1.9Z"/>
      <path d="m25 17.2 .45 1.1 1.1.45-1.1.45-.45 1.1-.45-1.1-1.1-.45 1.1-.45.45-1.1Z"/>
    </g></g>`;
}

export function mountBrands() {
  document.querySelectorAll('[data-brand]').forEach((link, index) => {
    link.innerHTML = `<svg class="mascot" viewBox="0 0 32 32" aria-hidden="true">${mascotMarkup(`brand-${index}`)}</svg><span>Piik<span class="identity-dot">.</span></span>`;
    const replay = () => link.getAnimations({ subtree: true }).forEach(animation => { animation.currentTime = 0; });
    link.addEventListener('pointerenter', replay);
    link.addEventListener('focus', replay);
  });
}
