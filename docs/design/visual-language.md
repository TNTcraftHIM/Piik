# Visual Language

This is the single design requirement for Piik's shared Web/App interface:
illustration, semantic colour, panel grammar, motion and tooltip presentation.
New UI work follows this file and the local `/__tooltip-preview` catalogue.
[Media status](./media-status.md) owns which facts justify each status;
[presentation lifecycle](../product/presentation-lifecycle.md) owns interaction
and playback. Neither an illustration nor its colour creates product state.

Use one stroke language for single concepts, small panel comics for causes and
sequences, and literal scene objects for people, rooms and media. Glyphs do not
form sentences. The same meaning and visual hierarchy must work in Chinese,
English and pure-visual modes, in both themes and at narrow widths.

Piik's living room uses simple silhouettes, generous space, rounded controls
and a small responsive bounce. Clear hierarchy and legible interaction keep
the playful details easy to use.
The [copy guide](../reference/naming.md#voice-and-terminology) owns its voice.
The [public introduction guide](./public-introduction.md) owns website and film
hierarchy: shared identity, current product demonstrations and promotional
composition. It applies the copy guide's audience and technical-detail layers.

Keep playfulness restrained: clean silhouettes, balanced proportions, quiet
expressions and brief gestures. Keep the interface approachable; avoid
pushing ordinary characters toward infant proportions, exaggerated
grins, dense cute decoration or children's picture-book styling.

## Layout And Input

Present a small shared living room: the television is the media stage, the
couch and pawns make presence spatial, and the four-digit room code stays
prominent. Decoration must clarify product facts without creating another state
model. Universal digits, transport symbols, URLs and measured values remain
literal when the user needs the data.

Functional controls use native buttons/inputs and localized accessible names.
Hover, keyboard focus and touch receive equivalent guidance. Keep information
order and interaction ownership consistent across languages, themes and viewport
sizes. Reflow or bounded scrolling must not hide a primary action, truncate an
essential value, overlap controls or change meaning.

Help-only indicators toggle their guidance on click or tap and dismiss on a
second activation, outside tap, Escape or focus leaving. Action controls keep
their direct click action and offer touch guidance on long-press. `Tooltip`
owns both interactions; pages do not add their own open state or timers.

Tooltips, state overlays and entry/error pages reuse the same illustrative scene
in every mode.
Chinese and English add a concise caption beneath it; pure-visual mode keeps the
scene and its playful pictograms as an explicit alternative. Names, addresses and other literal
values without a corresponding scene remain text. Illustration and caption
explain the same action or current fact, with one tone and motion owner. Mount
scenes only while their tooltip or overlay is shown; captions remain readable
throughout.

Shared buttons and chips use pill shapes, a quiet lower edge and a short lift
on hover or keyboard focus, then compress on press. Inputs and option tiles
share softer corners. Keep a distinct focus ring and a persistent selected
state; disabled controls must not pretend to activate. Reduced motion keeps
the colour, outline and selected position without decorative displacement.

## Cast And Objects

The brand mascot keeps its own identity, separate from ordinary participants.
Participant characters should leave room for that distinctive presence.

| Meaning | Representation |
| --- | --- |
| The person using the pictured action | Green pawn (`YOU` / `--you`), in every panel |
| Somebody else | Blue pawn (`SKY`), or another distinct non-green illustration colour |
| Host role | Gold crown above the head: rounded three-point outline, dark gold edge and a quiet lower rim; the standalone absent-Host symbol uses the same outline, unfilled and dashed |
| Shared or watched media | Small television, including antenna, body and feet |
| Browser application | Browser chrome around content; not a second design of television |
| A captured window or display | Window title bar or display stand, with the shared media metaphor kept distinct |
| Server forwarding media | A server on the media path; opening a Site alone does not imply SFU |

These are **identity/object colours**, not status. A green pawn remains green
in a failed scene; a successful scene does not turn other people green. Real
roster identities retain the shared UUID colour function, not the illustrative
"you versus others" palette. Actor positions and identities remain stable from
the first panel to the result.

Room pawns, tooltip/status comics and introduction participants use
a round head, half-oval body and two restrained eyes. Reuse the shared
figure and face geometry in product illustrations so expressions stay inside
the head as it scales. Larger scenes can add a small lean; small status panels
may omit facial detail to keep the action clear. When a gesture needs hands,
use small floating round shapes. A held gamepad is a scene prop; a separate role
crown identifies the host and moves with the body. Its gold is an identity colour,
not a warning or achievement. The share control retains its
cast icon. The cast represents friends sharing games, drawings
and other screen content. Exploratory figures are not alternate
participant identities. Keep the brand mascot distinct.

The couch has a back, seat, arms and feet. A full room reflows into rows of seats
without hiding people or requiring horizontal scrolling. Topology preserves
each participant and actual parent edge at a readable scale; reduce spare
spacing, then use a vertical outline when depth exceeds the available width.

Couch upholstery uses the fixed warm orange/yellow `--couch` / `--couch-dark`
palette. Never draw upholstery from the participant palette or randomize it by
room. Keep automatic participant colours outside the upholstery's amber/orange
range and the crown's gold; check all eight tokens against both objects in light
and dark themes. The crown retains a bright gold fill with a dark gold edge.
Figures and exterior upholstery use flat fills without outline strokes.
Use differences in tone, spacing and name tags to keep people readable; retain
only the few interior seams that clarify cushions. Apply this convention to
the website and README cast as well as the product UI.

## Semantic Colour And Shape

Use the existing theme tokens in `src/client/styles.css`. The shared
`comic-presentation.ts` maps meanings to those tokens for tooltip outlines,
carets, result panels and verdict marks. Do not choose independent hex colours
or animation rules inside an individual scene.

| Meaning | Token / code tone | Panel and symbol |
| --- | --- | --- |
| Explanation, preference, ordinary action, intentional closure or unknown state | Neutral ink / `off` | Neutral panels; illustrate the action/object without a success stamp |
| Confirmed completion or delivered media | Green `--live` / `live` | Neutral before, green result; check or completed object |
| Still usable with a limitation, unavailable optional capability, or intentional media pause | Amber `--warn` / `warn` | Neutral before, amber result; limit, pause, lock or unavailable mark on the affected part |
| Confirmed failed or blocked action | Red `--danger` / `bad` | Neutral before, red result; cross, broken path or other explicit failure mark |
| Work in progress or awaiting an action/frame | Blue `--action` / `busy` | Neutral before, blue current/result panel; connection, progress or play symbol |

Recovery retains amber because service is interrupted while work continues.
Waiting for a Host and unknown observations remain neutral. A control's
prospective action is not proof of success: opening details, switching theme,
adjusting volume or offering P2P stays neutral. Actual copy feedback can change
that same hint to green or red, using the existing operation result.

Two-panel comics always read before/context on the left and result/current
condition on the right. Only the result carries the semantic accent; a single
panel carries the current condition. Tooltip outline and caret use that same
tone in Chinese, English and visual modes. Neutral uses theme ink, not literal
white. Keep paper fills quiet; do not tint the whole scene green/yellow/red.
Meaning must also survive without colour through objects, symbols and accessible
localized names. Never show celebration or a completed live path as the verdict
of a failed or unavailable operation.

A missing optional feature is not a failed media path. For example, unavailable
NAT prediction marks only extra candidate paths; ordinary P2P remains a neutral
possibility. A rejected PiP request is failure; lack of PiP support is a limitation.

## Motion Grammar

| Presentation | Rule |
| --- | --- |
| Action demonstration (`demo`) | Play one meaningful transition when shown, then hold its result |
| Work actually continuing (`progress`) | Repeat a gentle connection/recovery beat while that state exists |
| Settled success, failure, limitation, pause or idle (`still`) | Show the informative final pose immediately; no repeated stamping, shaking, blinking or celebration |

Demonstrations and progress share the existing 3.2-second comic beat. The main
action belongs in its first half, followed by a readable hold; small internal
staggering is allowed. At most two independent movers per panel. An explanatory
slider describes purpose and available range, not its live numeric value.
Decorative sparkle must support the pictured action, never fake current success.

Reduced motion and settled states reuse each scene's **same explicit final
pose**. Disabling animation alone is insufficient if the base SVG hides the
result or shows a misleading starting pose. Static styling is scoped to its SVG;
one still tooltip must not freeze another progress scene. New keyframes must end
in the documented result rather than reset for an obsolete loop.

The tooltip panel itself uses the same restrained entrance/exit for every tone.
Replay belongs to opening/hovering/focusing the whole control, not just its SVG.
Ordinary controls keep their icons visible during hover and keyboard focus;
surface colour, lift, focus and press feedback carry the interaction. Reserve
icon drawing/replay for primary actions such as starting a share or joining a
room, and for explicit state-entry feedback. The whole control owns the trigger.
Stroke and solid drawings share one total duration and easing; stroke count
must not lengthen the animation. Disabled controls and passive status icons
retain their informative pose; busy indicators retain their progress beat.
Do not add a per-scene timer or another interaction/state owner. Outside status
comics, the brand mascot and participant figures may blink or glance occasionally;
a pictured screen can guide the Host's gaze. Keep eye gestures and small body
leans brief, separated by long pauses and offset between people. A participant's
UUID seeds the cadence; align its phase to wall time in every view, including
later mounts and return from background. Names, roster order and the observer's
role do not reseed it. Device clock skew bounds cross-device precision; cosmetic
motion adds no signaling or media state. They express personality independently
of connection feedback. Follow the system's reduced-motion preference, keeping a
natural, open-eyed pose when enabled; participant gestures have no separate
product playback control. Status comics still follow the table above.

Introduction artwork is separate from product status. Website/README scenes may
repeat a short action with a generous pause. Keep broad movement to one or two
focal elements; small participant gestures follow the quiet cadence above.
Provide a pause or hide control for automatic loops, and a useful static pose
for reduced motion. Product-state comics still follow the table above.

Entry screens may carry one quiet, original welcome line in Chinese or English
text mode. Pure-visual mode pairs familiar pictograms with static pixel
pseudo-lettering tied to the same line. This decoration is hidden from assistive
technology. The selected line stays stable during that visit, including mode
changes, and never replaces an action, error, loading message or connection
progress. Keep it on one line, apart from the actions; primary controls take
precedence when space is tight.

## Ownership And Incremental Review

- Existing status/operation facts outrank the scene default. Reused `warning`
  artwork can represent a warning or a confirmed failure; pass the actual tone.
- `comic-presentation.ts` owns defaults and semantic tokens; `Frame`, `RedX`,
  `rmBlock`, `Comic` and `HintComic` apply the shared grammar. Scenes own only
  their cast, causal illustration and final pose. `Tooltip` owns interaction
  and placement. Do not duplicate these rules in each scene or page.
- Keep the semantic kind and tone in all languages; localized text changes
  expression, not severity. Symbol-only controls retain accessible names.
- For each changed scene inspect its start, transition and settled pose in
  both themes, reduced motion and narrow layouts. Compare success, failure,
  limitation and neutral neighbours in the catalogue. Code-level tests do not
  establish visual clarity.
- Update this owner when accepting a new convention. Product documents link
  here instead of copying the palette, cast or animation table.

## Interaction References

[Carbon status indicators](https://v10.carbondesignsystem.com/patterns/status-indicator-pattern/)
supports combining semantic colour with shape and symbols;
[Carbon motion](https://carbondesignsystem.com/elements/motion/overview/)
distinguishes functional feedback from occasional expressive movement.

[Web Animations start time](https://developer.mozilla.org/en-US/docs/Web/API/Animation/startTime)
provides the native timeline alignment used by participant gestures.
