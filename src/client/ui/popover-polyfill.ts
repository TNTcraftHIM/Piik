import "@oddbird/popover-polyfill";

// Native Escape dismissal follows event dispatch; the polyfill closes auto
// popovers in its document listener. Mark that key as consumed before outer
// panels/theater handle it, without taking over the polyfill's dismissal.
const dismissals = new WeakSet<KeyboardEvent>();
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !document.querySelector('[popover="auto"]:popover-open')) return;
  if (event.isComposing) event.preventDefault();
  else dismissals.add(event);
}, true);
document.addEventListener("keydown", event => {
  if (dismissals.has(event)) event.preventDefault();
});
