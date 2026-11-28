import { apply } from "@oddbird/popover-polyfill/fn";

const openAutoPopover = '[popover="auto"]:popover-open';

document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  // In Piik, nested auto popovers belong to their containing disclosure.
  const popover = [...document.querySelectorAll<HTMLElement>(openAutoPopover)]
    .find(layer => !layer.querySelector(openAutoPopover));
  if (!popover) return;

  event.preventDefault();
  if (!event.isComposing) popover.hidePopover();
});

// Run after component key handlers and before OddBird's document handler,
// which closes every open auto popover on Escape.
apply();
