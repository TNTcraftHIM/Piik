import type { Plugin } from "vite";
import { locales, isLang, resolveLang } from "../src/client/locales/index.ts";
import { LANG_STORAGE_KEY, readStoredCopy } from "../src/client/ui/copy.ts";

/** The React startup boundary cannot render before its entry module loads. */
export function startupFallback(): Plugin {
  const copy = Object.fromEntries(Object.entries(locales).map(([lang, { copy: catalog }]) =>
    [lang, [catalog["startup.failed"], catalog["startup.retry"], catalog["common.refresh"]]]));
  return {
    name: "startup-fallback",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        if (!html.includes('<div id="root"></div>')) return;
        html = html.replace(/<script\b(?=[^>]*type="module")(?=[^>]*src="(?!\/@vite\/))[^>]*>/,
          tag => tag.replace("<script", '<script data-piik-entry'));
        if (!html.includes("data-piik-entry")) return;
        html = html.replace('<div id="root"></div>', '<div id="root"><section id="piik-startup-failure" hidden role="alert"><h1></h1><p></p><button type="button"></button></section></div>');
        const tags = [{ tag: "style", children: `
#piik-startup-failure:not([hidden]){box-sizing:border-box;max-width:28rem;margin:clamp(3rem,15vh,9rem) auto;padding:2rem;font:1rem/1.6 var(--font,system-ui,sans-serif);color:var(--ink,CanvasText);background:var(--paper,Canvas);border:1px solid var(--line,GrayText);border-radius:var(--radius,16px)}
#piik-startup-failure h1{font-size:1.5rem;margin:0 0 .75rem}
#piik-startup-failure p{margin:0 0 1.5rem}
#piik-startup-failure button{font:inherit;padding:.6rem 1rem;border:1px solid var(--control-edge,GrayText);border-radius:var(--control-radius,18px);background:var(--paper,ButtonFace);color:var(--ink,ButtonText);cursor:pointer}
@media(max-width:32rem){#piik-startup-failure:not([hidden]){margin:3rem 1rem}}` },
        { tag: "script", children: `(function () {
  var copy = ${JSON.stringify(copy).replaceAll("<", "\\u003c")};
  var locales = ${JSON.stringify(Object.fromEntries(Object.entries(locales).map(([key, value]) => [key, { tag: value.tag }])))};
  var LANG_STORAGE_KEY = ${JSON.stringify(LANG_STORAGE_KEY)};
  var isLang = ${isLang.toString()};
  var resolveLang = ${resolveLang.toString()};
  var readStoredCopy = ${readStoredCopy.toString()};
  function isEntry(event) { return event.target instanceof HTMLScriptElement && event.target.hasAttribute('data-piik-entry'); }
  function retire() { window.removeEventListener('error', failed, true); document.removeEventListener('load', loaded, true); }
  function loaded(event) { if (isEntry(event)) retire(); }
  function show() {
    var panel = document.getElementById('piik-startup-failure');
    if (!panel) return;
    var stored = readStoredCopy();
    var lang = stored.lang || resolveLang(navigator.language);
    // Match the launch preference precedence owned by app-launch.ts and applyLaunchCopy.
    var launch = new URLSearchParams(location.hash.slice(1));
    var requested = launch.get('piik-lang');
    var explicit = (new URLSearchParams(location.search).get('piik-preferences') || '').split(',').includes('copy');
    if (launch.get('piik-client') === '1' && isLang(requested) && (explicit || !stored.lang)) lang = requested;
    var text = copy[lang];
    panel.lang = locales[lang].tag;
    panel.querySelector('h1').textContent = text[0];
    panel.querySelector('p').textContent = text[1];
    var button = panel.querySelector('button');
    button.textContent = text[2];
    button.addEventListener('click', function () { location.reload(); });
    panel.hidden = false;
  }
  function failed(event) {
    if (!isEntry(event)) return;
    retire();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show, { once: true });
    else show();
  }
  window.addEventListener('error', failed, true);
  document.addEventListener('load', loaded, true);
})();` }];
        // Keep charset first; prepend immediately before the generated entry, not before metadata.
        return html.replace(/<script data-piik-entry\b/, tags.map(tag => `<${tag.tag}>${tag.children}</${tag.tag}>`).join("\n") + "\n<script data-piik-entry");
      },
    },
  };
}
