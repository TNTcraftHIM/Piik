# Display name and presence boundaries

Accessed 2026-08-20. This note records only the browser and Unicode facts that constrain the local-name slice.

## Primary sources

- [WHATWG HTML: Web storage](https://html.spec.whatwg.org/multipage/webstorage.html#the-localstorage-attribute) defines `localStorage` as origin-scoped client storage. Access and writes may fail, so a display-name preference must remain optional and fall back without blocking room access.
- [ECMAScript: `String.prototype.normalize`](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.normalize) provides explicit Unicode normalization. Screener uses NFC before applying its code-point limit and before sending the value.
- [Unicode UAX #31](https://www.unicode.org/reports/tr31/) documents normalization and the security concerns around invisible/default-ignorable and bidirectional controls. Display names are not identifiers, but rejecting controls and bidi overrides avoids misleading roster text while allowing ordinary multilingual labels and emoji.

## Retained design

The browser is the only durable owner of a display-name preference. The signaling server retains the canonical value only on the authenticated socket state and derives an authoritative online snapshot from current connected sessions. Presence is display-only: it neither authorizes nor changes media routing. For Web display, an SFU Viewer entry carries `sfuMediaReady: true` only after first media is bound to its current session, active route revision, and publication generation; absence stays neutral, while track, route, or session loss removes the proof. Browser Hosts and Viewers explicitly opt in to the shared participant snapshot; executable senders are outside the current Browser contract. Host defaults may be derived from the room-scoped stable client ID, but the value is still local/socket-only.

## Current roster presentation

The live roster uses the display name alone when it is unique in the current room snapshot. When two or more participants use the same name, only those colliding entries append the shortest room-scoped `peerId` suffix that distinguishes them, starting at six characters and extending only for a suffix collision. A suffix collision between different names does not change either label. This is presentation-only; the suffix remains opaque and never participates in authorization, routing, or quality decisions.

Host and Viewer pages consume the same authoritative participant snapshot. The Viewer roster renders only Viewer entries, including the local Viewer, and replaces the whole list on each snapshot so joins, leaves, renames, and reconnections do not require a second client-side membership model.
