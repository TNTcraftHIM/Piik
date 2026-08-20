# Display name and presence boundaries

Accessed 2026-08-20. This note records only the browser and Unicode facts that constrain the local-name slice.

## Primary sources

- [WHATWG HTML: Web storage](https://html.spec.whatwg.org/multipage/webstorage.html#the-localstorage-attribute) defines `localStorage` as origin-scoped client storage. Access and writes may fail, so a display-name preference must remain optional and fall back without blocking room access.
- [ECMAScript: `String.prototype.normalize`](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.normalize) provides explicit Unicode normalization. Screener uses NFC before applying its code-point limit and before sending the value.
- [Unicode UAX #31](https://www.unicode.org/reports/tr31/) documents normalization and the security concerns around invisible/default-ignorable and bidirectional controls. Display names are not identifiers, but rejecting controls and bidi overrides avoids misleading roster text while allowing ordinary multilingual labels and emoji.

## Retained design

The browser is the only durable owner of a display-name preference. The signaling server retains the canonical value only on the authenticated socket state and derives an authoritative online snapshot from current connected sessions. Presence is display-only: it neither authorizes nor changes media routing. A Web Host must opt in so the existing Native sender exact parser receives no new server message or field.
