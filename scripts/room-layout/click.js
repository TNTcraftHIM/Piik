// usage: CLICK("name", index) — clicks visible element whose accessible name equals or starts with name
window.__click = (n, i = 0, exact = false) => { const name = e => (e.getAttribute('aria-label') || e.getAttribute('title') || e.innerText || '').replace(/\s+/g, ' ').trim();
  const all = [...document.querySelectorAll('button,a[href],[role=button],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=tab],[role=option],label,summary')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const m = all.filter(e => exact ? name(e) === n : name(e) === n || name(e).startsWith(n));
  if (!m[i]) return 'NOTFOUND ' + n + ' (' + m.length + ')'; m[i].scrollIntoView({block:'nearest'}); m[i].click(); return 'clicked ' + name(m[i]).slice(0, 40); };
