(() => {
  const rect = selector => {
    const node = typeof selector === "string" ? document.querySelector(selector) : selector;
    if (!node) return null;
    const r = node.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { l: Math.round(r.left * 10) / 10, r: Math.round(r.right * 10) / 10, t: Math.round(r.top * 10) / 10, b: Math.round(r.bottom * 10) / 10, cx: Math.round((r.left + r.right) / 2 * 10) / 10 };
  };
  const visible = node => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(node).visibility !== "hidden"; };
  const shell = document.querySelector(".c3-shell");
  const bar = document.querySelector(".c3-personal");
  const controls = bar ? [...bar.querySelectorAll(".lr-btn, .c3-voice-room-info")].filter(node => visible(node) && !node.closest(".c3-identity")) : [];
  const cluster = controls.length ? { l: Math.min(...controls.map(n => n.getBoundingClientRect().left)), r: Math.max(...controls.map(n => n.getBoundingClientRect().right)) } : null;
  const tiles = [...document.querySelectorAll(".c3-monitor-tile:not([hidden])")].filter(visible).map(rect);
  const pictures = [...document.querySelectorAll(".c3-monitor-tile:not([hidden]) > :is(.c3-video, .c3-monitor-wait)")].filter(visible).map(node => node.getBoundingClientRect());
  const area = pictures.reduce((sum, r) => sum + r.width * r.height, 0);
  return {
    viewport: [innerWidth, innerHeight],
    scrolls: document.documentElement.scrollHeight > innerHeight + 1 || document.documentElement.scrollWidth > innerWidth + 1,
    shell: rect(shell),
    stage: rect(".c3-main-body"),
    chat: rect(".c3-chat-panel"),
    roomIcon: rect(".c3-room-name > svg, .c3-room-name > .c3-identity-mark, .c3-room-name > img"),
    roomName: rect(".c3-room-name h2"),
    date: rect(".c3-message-date"),
    avatar: rect(".c3-message > svg"),
    messageText: rect(".c3-message-content-body"),
    composer: rect(".c3-composer"),
    composeField: rect(".c3-compose-input"),
    couch: rect(".c3-couch-scene"),
    bench: rect(".c3-couch-bench"),
    bar: rect(bar),
    identity: rect(".c3-personal .c3-identity > svg"),
    cluster: cluster && { l: Math.round(cluster.l * 10) / 10, r: Math.round(cluster.r * 10) / 10, cx: Math.round((cluster.l + cluster.r) / 2 * 10) / 10 },
    tiles,
    controls: shell?.dataset.controls, head: shell?.dataset.head, rooms: shell?.dataset.rooms, pane: shell?.dataset.pane,
    lastTool: rect(document.querySelector(".c3-living-app .lr-btn .lr-cap") ?? [...document.querySelectorAll(".c3-room-tools .lr-btn svg")].filter(visible).pop()),
    couchText: Math.min(...[...document.querySelectorAll(".c3-couch .lr-pawn-name")].filter(visible).map(node => parseFloat(getComputedStyle(node).fontSize) * (node.currentCSSZoom ?? 1)), 99),
    toolSizes: [...new Set([...document.querySelectorAll(".c3-site-bar .lr-btn")].filter(visible).map(node => Math.round(node.getBoundingClientRect().height)))],
    homeMark: rect(".c3-site-home svg"), itemIcon: rect(".c3-room-link .c3-identity-mark"), itemName: rect(".c3-room-link strong"),
    myName: rect(".c3-personal .c3-identity strong"), navLabel: rect("#c3-room-list-heading"), group: rect(".c3-room-group-heading"),
    siteCell: rect(".c3-site-identity"), sidebar: rect(".c3-sidebar"), heading: rect(".c3-room-heading"),
    pictureShare: Math.round(area / (innerWidth * innerHeight) * 1000) / 10,
    fonts: [...new Set([...document.querySelectorAll(".c3-shell *")].filter(node => !node.closest(".c3-couch") && visible(node) && [...node.childNodes].some(child => child.nodeType === 3 && child.textContent.trim())).map(node => parseFloat(getComputedStyle(node).fontSize)))].sort((a, b) => a - b),
  };
})()
