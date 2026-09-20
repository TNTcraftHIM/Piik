# Visual Language

This is the single design requirement for Piik's shared Web/App interface:
illustration, semantic colour, panel grammar, motion and tooltip presentation.
New UI work follows this file and the local `/__tooltip-preview` catalogue.
[Media status](./media-status.md) owns which facts justify each status;
[presentation lifecycle](./presentation-lifecycle.md) owns interaction
and playback. Neither an illustration nor its colour creates product state.

Use one stroke language for single concepts, small panel comics for causes and
sequences, and literal scene objects for people, rooms and media. Glyphs do not
form sentences. The same meaning and visual hierarchy must work in Chinese,
English and pure-visual modes, in both themes and at narrow widths.

Piik's living room uses simple silhouettes, generous space, rounded controls
and a small responsive bounce. Clear hierarchy and legible interaction keep
the playful details easy to use.
The [copy guide](./naming.md#voice-and-terminology) owns its voice.
The [public introduction guide](./public-introduction.md) owns website and film
hierarchy: shared identity, current product demonstrations and promotional
composition. It applies the copy guide's audience and technical-detail layers.

Keep playfulness restrained: clean silhouettes, balanced proportions, quiet
expressions and brief gestures. Keep the interface approachable; avoid
pushing ordinary characters toward infant proportions, exaggerated
grins, dense cute decoration or children's picture-book styling.
This balance applies to all comic hints, status overlays and entry/error scenes.

Consistency governs meaning, cast and interaction, not identical compositions.
Give each explanation a recognisable little scene: a welcoming hop, a curious
peek or a character leaning into an action. Anticipation, a soft landing and
staggered responses make movement expressive. Reuse drawing primitives and motion
ownership; do not reduce distinct situations to one layout with a swapped symbol.

## Layout And Input

Present a small shared living room: the television is the media stage, the
couch and pawns make presence spatial, and the four-digit room code stays
prominent. Decoration must clarify product facts without creating another state
model. Universal digits, transport symbols, URLs and measured values remain
literal when the user needs the data.

Functional controls use native buttons/inputs and localized accessible names.
Pointer cursors identify actions, navigation and controls that change a setting;
text inputs use text cursors. Read-only status and metric indicators keep the
ordinary arrow even when tapping reveals an explanation. Keep these help-only
triggers as native buttons for keyboard and touch access. Passive labels and
illustrations also keep their ordinary cursor.
Hover, keyboard focus and touch receive equivalent guidance. Keep information
order and interaction ownership consistent across languages, themes and viewport
sizes. Reflow or bounded scrolling must not hide a primary action, truncate an
essential value, overlap controls or change meaning.

Keep the application language control's segmented Chinese, English and visual
shortcuts. When additional catalogs exist, insert one language menu
after the visual shortcut; all extra languages share that slot. Show the
selected language's short label there and native names inside the menu. Reuse
the sliding selection, rounded paper panels and control motion. The native
popover owns visibility, outside-click dismissal and Escape; the language
control owns menu navigation, focus and viewport placement. Keep touch rows
large and long lists scrollable. Locale labels belong to the shared registry.
Use a globe and chevron for the unselected picker, and each language's own full
name in the menu, following [W3C language-navigation guidance](https://www.w3.org/International/questions/qa-navigation-select).

Help-only indicators toggle their guidance on click or tap and dismiss on a
second activation, outside tap, Escape or focus leaving. Touch long-press opens
guidance after a 500 ms hold on both help indicators and action controls,
without triggering the action on release. Action controls keep their direct
short-tap action. `Tooltip` owns these interactions; pages do not add their own
open state or timers.

Mouse hover opens after 500 ms of staying on the trigger; passing through or
operating a control cancels that pending hint. Keyboard focus and explicit help
activation do not wait. Keep the open panel hoverable for reading, with a short
crossing grace; Escape, clicking the panel or clicking elsewhere dismisses it.
A panel click only dismisses guidance and never activates an underlying control.
Keep the comic compact without reducing caption legibility. Player hints prefer
available space beside or below the television; when that does not fit, clear
the whole playback bar. A wrapped option row is also one area to avoid. Status,
headers and bottom-of-picker controls prefer below; other controls prefer above.
Flip to fit the viewport and keep the caret aimed at the trigger. Placement and
hover timing belong to the shared component.

Add a tooltip when it explains an action, a limitation or a status that needs
context. Plain names, decorative participants and self-explanatory text do not
need another popup. Keep participant details on their existing click action and
state explanations on the dedicated status indicator.

When a nickname is clipped, the shared tooltip reveals its complete literal
text in every language mode, without a comic or repeated role/status labels.
Show this only after detecting actual truncation; resize and name changes must
recheck it. Preserve hover, keyboard and touch-hold access, and the participant's
existing click action. A complete or wrapping name needs no extra focus stop or
popup. If a status tooltip already wraps the row, add the clipped name there
rather than nesting another tooltip.

Tooltips, state overlays and entry/error pages reuse the same illustrative scene
in every mode.
Chinese and English add a concise caption beneath it; pure-visual mode keeps the
scene and its playful pictograms as an explicit alternative. Literal names and
addresses keep their exact text. An invitation explanation retains its link
scene; simply revealing a clipped name needs only the name.
Do not substitute an unrelated action just to fill a tooltip. Illustration and caption
explain the same action or current fact, with one tone and motion owner. Mount
scenes only while their tooltip or overlay is shown; captions remain readable
throughout.

Metric icons and hints share the `metric-presentation.ts` definition in details
and overview headings. Frames, packets, jitter and audio repair have distinct
symbols; related time measurements keep a clock with a scene identifying the
measured stage. Illustrations explain a metric, never invent its current value,
threshold or quality verdict.

Shared buttons and chips use pill shapes, a quiet lower edge and a short lift
on hover or keyboard focus, then compress on press. Inputs and option tiles
share softer corners. Keep a distinct focus ring and a persistent selected
state; disabled controls must not pretend to activate. Reduced motion keeps
the colour, outline and selected position without decorative displacement.
The shared button uses the same pressed value for `aria-pressed` and its selected
treatment; active state remains distinct from hover in both themes.
Disclosure buttons keep a stable visible caption, while their expanded state and
accessible action describe opening or closing. Neutral panel borders stay quieter
than the controls inside them; nested diagnostic panels retain their softer fill.
Keep room identity, invitation and admission controls ahead of expanded topology
and connection details, so inspecting a route does not displace room actions.

Sharing and local playback controls use the same quiet, compact button treatment.
The Host's persistent dock stays below the picture; the Viewer's playback bar
belongs to the video. Their similar appearance does not equate broadcast pause
with local playback pause. Waiting overlays use the space above the actual
playback bar, including when it wraps. Keep the primary status readable on
narrow screens; optional waiting copy yields first. Microphone mute, sharing
pause, source replacement and stop remain direct actions; stopping stays
visually separated from frequent actions.
One compact dock combines direct actions and the sharing-settings entry below
the television, above the couch. Its disclosure groups quality presets and picture
parameters with sound and microphone settings; presets remain available before
sharing starts. Separate the less frequent connection/codec options in a nested
disclosure. Expand in page flow, pushing later content down instead of covering
the picture or participants. Use two content groups on wide screens and stack
them on narrow screens; avoid another permanent row of settings cards. Keep
shared presentation separate from the existing setting/resource owners.
The microphone comic depicts Host commentary gain;
the Viewer's listening-volume comic remains a different action.

Visual source choices (windows, screens and cameras) share named thumbnail cards,
including their focus, hover and refresh treatment. Microphone selection uses
device names in a compact selector. Shared enumeration does not make these two
selection tasks visually interchangeable.

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
| A camera source or Host commentary | `camera` identifies the alternative picture source; `microphone` identifies the enabled Host voice input and `microphoneOff` its muted state. Neither replaces the speaker metaphor for source/playback sound. |
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
may omit facial detail to keep the action clear. Compact comic pawns stay small
and handless: use gaze, body lean and short hops to express their action. Keep
their scale consistent with neighbouring scenes in the same family. The relevant
door, credential or media object carries the explanation; people provide scale
and a response. Leave space around them so the action is legible. Use the
room-admission examples in `/__tooltip-preview` as a reference for compact
proportions and detail, while giving other subjects their own appropriate scene.
Large introduction illustrations may use small floating round hands to hold a prop.
A held gamepad is a scene prop; a separate role crown identifies the host and
moves with the body. Its gold is an identity colour,
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

## Symbol Reference

This reference applies to controls, status strips, comics, overlays, document
titles, placeholders and public product demonstrations. A symbol keeps its
basic meaning across those surfaces. Its nearby label identifies the affected
object; it must not silently acquire a different measurement or permission.
This reference describes functional meaning in context, not exclusive ownership
of every shape. Decorative lettering, welcome ornaments and shared screen
content do not become controls or measurements by using a familiar symbol.

[Glyph](../../src/client/ui/icons.tsx) owns small-icon geometry and the accepted
`GlyphName` union. Use it for controls and embedded comic symbols; reuse `MiniTv`,
`Pawn`, `InviteLink` and the other shared scene objects for illustrations. Select
existing meanings before adding an icon. A new meaning needs a row here and a
rendered example in the existing catalogue. A typo or missing icon must fail
type checking rather than silently render a warning triangle.

| Meaning / 含义 | Symbols | Use and boundary |
| --- | --- | --- |
| Participants and room / 人与房间 | `users`, `couch`, `door` | People, shared room, room entry. Use the shared pawn for a person and `HostMark` for Host authority. |
| Shared screen / 共享画面 | `tv`, `MiniTv`, 📺 | Media or its sharing source. The TV beside the Host name identifies the source; the crown on a person identifies the role. |
| Start and choose a source / 分享与选源 | `cast`, `share`, `switchSource` | Start sharing, capture a screen, replace the current capture source respectively. A captured window keeps window chrome or a display stand. |
| Capture source / 采集来源 | `window`, `display` | An application window or a whole display; these nouns remain distinct from the source-switch action. |
| Invitation URL / 邀请链接 | `link`, `InviteLink`, `linkOff` | A URL and its disabled/revoked form. Keep the chain when copying or rejecting it. Copying is local; a send-to-chat scene is a separate action. |
| Credential / 凭证 | `key`, password dots | Site passphrase or room password, identified by the field label. Room-code admission with a password shows both fields. |
| Restriction / 受限 | `lock` | Restricted entry, concealed password or a setting fixed by availability; show the affected object. A lock never promises anonymity or secure media. |
| Site and public entry / 站点与公开入口 | `globe` | Browser/Site entry or code-based public entry. It does not claim internet reachability. |
| Connections / 连接 | `network`, `branch`, `signal`, `wifiOff`, `server` | Topology, branching, signaling, disconnected signaling and the named server. A server on a media path means forwarding; a Site backend or control-link server alone does not imply SFU. An invitation chain does not represent signaling. |
| Playback / 播放 | `play`, `pause`, `stop` | Play/resume, pause, end. The control label states whether it affects local viewing or the Host's share. Stop is distinct from a paused or idle room. |
| Audio / 声音 | `speaker`, `speakerOff` | Audio and mute/no audio, qualified by the source or local playback label. A source track's presence does not establish delivered sound. |
| Size and viewing mode / 尺寸与观看模式 | `expand`, `contract`, `pip`, `pipExit`, `theater`, `theaterExit` | Expand/restore, enter/leave picture in picture, enter/leave theatre mode. The same size symbol can accompany a resolution measurement. |
| Local actions / 本地操作 | `copy`, `save`, `pencil`, `eye`, `eyeOff` | Copy, save, edit, reveal and conceal the named object. An action icon does not prove completion. |
| Repeat and disclosure / 重试与展开 | `refresh`, `chevron`, `arrowRight` | Repeat/refresh, expand/collapse, proceed/enter. Direction follows the control's action; no arrow alone establishes delivery. |
| Transfer and upgrade / 传输与更新 | `arrowUp`, `arrowDown` | Outbound/inbound or upload/download, qualified by the adjacent label. An explicit update label may use the upward arrow for upgrade; neither arrow is a connection-quality rating. |
| Diagnostics / 诊断 | `cpu` | Technical diagnostics in the labelled diagnostic control; in metrics the same processor identifies encoding work. The surrounding control or measured field states the scope. |
| Settings / 设置 | `sliders`, `mountain`, `balance`, `frames` | Settings, preserve image detail, balanced preference, preserve frame rate. The frame-rate preference uses the same frames as the measured value. |
| Progress and result / 进度与结果 | `loader`, `alert`, `check`, `x` | In progress, a problem, confirmation/positive result, cancellation/negative result. The status owner supplies severity; the shape alone cannot set it. |
| Theme / 主题 | `sun`, `moon` | Light/dark appearance in theme controls. A moon in an idle-room scene means rest, with the idle scene providing that context. |
| Welcome decoration / 开场装饰 | `gamepad`, `popcorn`, `clapperboard`, `trophy`, `gift`, `flag`, `heart`, `bulb`, `zap` | Games, snacks, film, achievement, gift, next stop, affection, discovery and energy. These may decorate the welcome line, never a measured speed, failure or connection verdict. |

Metrics use [METRIC_PRESENTATION](../../src/client/components/living/metric-presentation.ts)
in both summaries and details. Labels, units and stage-specific comics distinguish
related values; views do not choose their own symbols.

Topology hover and keyboard focus use neutral outlines; selection adds a heavier
outline and text weight. Connection colours remain owned by route/readiness
facts, so interacting with a node cannot look like a connection-state change.

| Measurement / 指标 | Symbol | Boundary |
| --- | --- | --- |
| Frame rate / 帧率 | `frames` | Video frames per second, including capture/input frame rate. |
| Packet loss / 丢包 | `packetLoss` | Missing network packets, including audio packets. |
| Dropped frames / 丢帧 | `frameDrop` | Discarded video frames in the stated observation interval; never substitute packet loss or a cumulative total under the same interval label. |
| Jitter / 抖动 | `jitter` | Variation in arrival timing, including audio jitter. |
| Audio concealment / 音频补偿 | `audioRepair` | Missing audio concealed by the decoder. |
| Rate / 速率 | `gauge`, `speaker` for audio rate | Bitrate or outgoing rate; the unit remains visible. |
| Duration / 耗时 | `clock` | RTT, encode/decode time, freeze duration, playout or buffer time. The label and comic identify the measured stage. |
| Freeze count / 卡顿次数 | `pause` | Count of interrupted video progress, distinguished by its metric label from intentional pause. |
| Encoder and codec / 编码器与编码格式 | `cpu`, `puzzle` | Processing implementation and encoded format respectively. |

Text-only surfaces retain the same meanings:

| Surface | Standard and owner |
| --- | --- |
| Activity in document titles | [Title catalogs](../../src/client/locales/visual.ts): 📺 sharing/viewing, 🛋️ ready room, 💤 idle, ⏳ waiting/starting, ⏸️ paused, ▶️ waiting for playback, ⏹️ ended, ❗ unavailable. Secondary decorations cannot replace this leading meaning or imply new progress. |
| A problem beside an activity | [Media status](../../src/client/ui/media-status.ts) supplies ⚠️ from actual facts; [document-title](../../src/client/ui/document-title.ts) only composes and rotates titles. |
| Default names | [display-name](../../src/client/lib/display-name.ts) owns 📺 for the sharing source and 👤 for a Viewer in visual mode. Preserve user-entered emoji names as data; never infer role from their characters. [viewer-presence](../../src/client/lib/viewer-presence.ts) owns duplicate-name suffixes. |
| Visual-mode shortcut | ✦ in the language control and its documentation; not a success or quality mark. |
| Input placeholders | Four slots represent the four-digit room code. Password dots mask a field; their illustrated count imposes no password length. Numeric samples reuse the actual field's `--mono` typeface and weight. Real inputs retain localized labels. |
| Unknown values | `—` means unavailable/unknown, never zero or a healthy result. Keep exact values and units whenever known. |
| Capability values | `✓` / `✗` answer the adjacent boolean capability, not whether an entire route or share succeeded. |
| Shortened text | `…` means truncation. Preserve the full nickname/URL for reading and copying; never turn an exact value into a decorative code. |
| Welcome cipher | The locale entry owns its two meaningful symbols; [WelcomeLine](../../src/client/components/living/WelcomeLine.tsx) renders their pixel words. They are decoration, not hidden connection state. |

### Feedback Composition

Choose the illustration from the operation's scope and the caption from its
actual state. Each feedback region has one principal illustration; a comic does
not need a second mascot or decorative spinner. The header's brand mark remains
navigation identity. Keep an actionable play symbol or an exact progress value
when it helps the user proceed or understand the operation.

| Context | Illustration and literal content | Playful caption |
| --- | --- | --- |
| Page loading, site access check, App preparation | The shared wink mascot with the actual loading operation; no room or media-path claim | The current language's waiting pool |
| Source listing/start/switch, room joining, media setup/recovery, waiting for the Host | The corresponding comic with the current status; only the existing state owner can declare waiting | The same waiting pool while the wait exists |
| Error, limitation, pause, ended room or required user action | The corresponding comic and clear reason/action; settled movement keeps that verdict readable | None |
| Small controls, tooltips and inline results | Existing action/status icon and contextual guidance when needed; retain direct actions | None |

The shared `LoadingStatus`, `StageOverlay` and `WaitingCaption` apply this
composition; source selection reuses the caption beside its existing comic.
Do not infer waiting from a chosen drawing, mascot visibility or animation flag.
Healthy playback stays visible during control reconnection; this rule does not
create another overlay. An idle room awaiting a new share differs from a closed
room. In pure-visual mode keep the same illustration and accessible operation
name, with no waiting text. Welcome ciphers retain their separate role.
At compact player sizes, omit the optional caption before shrinking the comic
or the actual status into illegibility. The existing visibility policy suspends
hidden captions; viewport size does not become product state.

### Playful Copy Lifecycle

The shared [rotation owner](../../src/client/ui/text-rotation.ts) supplies the
clock and visibility policy; its React adapter and the static website consume
the same rule. Locale files own the independent pools.

Website/App welcome lines, waiting captions and playful title variations share
one lifecycle. Show an entry immediately, then change it every eight seconds
while visible. Draw without replacement until the current pool is exhausted.
An ordinary rerender or metric update does not restart the cycle. A new semantic
context or language starts from that context's current-language pool; never
reuse a cross-language array index. Hidden surfaces stop advancing. On return,
keep the current line for a full interval; reduced motion retains a static line.
Unmount or an ended context retires timers and listeners. Empty pools omit the
decoration; one-entry pools stay static. Real completion never waits for copy
or an animation to finish. This cadence is a product choice, not measured progress.

Each language maintains independent contextual pools without equal counts,
paired translation keys or a fixed total. Contributors can add a locally natural
entry without inventing equivalents in other languages. Keep operational labels
in the ordinary translation contract. Welcome ciphers attach meaningful symbols
to the selected entry, rather than depending on a global numeric correspondence.
Pure-visual waiting keeps the shared animated scene.

Actual status, error reasons, paused/ended states, required actions and slogans
remain literal. A title retains its primary activity and any applicable warning.
Waiting decorations never invent steps, remaining time or success; they are
excluded from live status announcements. Small controls retain concise labels
and their existing motion. Graphic composition still follows its own contextual
review; this copy policy does not require a mascot or a new tooltip everywhere.

| Existing surface | Copy coverage |
| --- | --- |
| Website welcome, App launcher, sharing entry | The current language's welcome pool; the App's visual mode renders that entry's cipher. |
| Loading, source selection and media waiting | A secondary waiting caption according to [feedback composition](#feedback-composition). |
| Browser tab | Sharing, watching, starting, ready-to-share, not-started and waiting states may append their own variations; room identity, literal activity and warnings remain visible. |
| Error, pause, ended state, required action, tooltip, small control | Keep the existing literal message and contextual graphic; no rotating caption is added. |

## Panel Composition

Choose panels by what the explanation asks the reader to compare:

| Composition | Use |
| --- | --- |
| Two panels | Default for action → effect or condition → outcome. The left supplies the action, credential or context; the right explains its consequence. Examples: copying an invitation, pausing playback, entering with a room code/password/invitation. |
| One wide panel | One ongoing or settled scene without a before/after comparison, or a continuous spatial relationship that a divider would break. Examples: waiting for the Host, an unavailable source, a network round trip. Width alone is not a reason to use it. |

Use the same composition and panel roles within a semantic family. Room-entry
credential hints all use two panels: accepted credential on the left, access to
the room on the right. The door scene explains admission; it does not claim that the user is
changing privacy or has already joined. Vary the small gestures and useful props,
not the reading order. Keep full-scene states and metric diagrams in one panel
when splitting them would only duplicate the scene or interrupt its relationship.
More than two panels require distinct steps of a real sequence that cannot be
explained clearly in two; do not invent stages to fill extra panels.

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

Review meaning at the call site. A current admission badge shows the credential
accepted by [room access](./rooms-access.md). The private-mode control instead
shows restricted code-only entry with a closed door; its meaning must not change
to an invitation action merely because no room password is set. This room-entry
rule is separate from media-route privacy. Password input is not proof of
admission; copying writes to the local clipboard and does not send to a friend. An audio track's presence does not
establish a locked control or delivery to another device.

Only the result carries the semantic accent; a single panel carries the current
condition. Tooltip outline and caret use that same tone in Chinese, English and
visual modes. Neutral uses theme ink, not literal white. Keep paper fills quiet;
do not tint the whole scene green/yellow/red.
Meaning must also survive without colour through objects, symbols and accessible
localized names. Never show celebration or a completed live path as the verdict
of a failed or unavailable operation.

A missing optional feature is not a failed media path. For example, unavailable
NAT prediction marks only extra candidate paths; ordinary P2P remains a neutral
possibility. A rejected PiP request is failure; lack of PiP support is a limitation.

## Motion Grammar

| Presentation | Rule |
| --- | --- |
| Action demonstration (`demo`) | Explain an action with a short gesture and a readable hold; repeat while its tooltip is displayed |
| Work actually continuing (`progress`) | Repeat a gentle connection/recovery beat while that state exists |
| Settled success, failure, limitation, pause or idle (`still`) | Keep the result readable while a related character or object moves; tooltip gestures loop without re-running the actual operation or changing the verdict |

Demonstrations and progress share the existing 3.2-second comic beat. The main
action belongs in its first half, followed by a readable hold; small internal
staggering is allowed. Keep one focal gesture at a time; other characters can
answer it with a delayed reaction. A small action and a readable pause can carry
the whole explanation; extra movement needs a purpose beyond making the scene
busier. An explanatory slider describes purpose and available range, not its
live numeric value.
Decorative sparkle must support the pictured action, never fake current success.

The shared tooltip owns repetition for hover, keyboard focus and click/tap;
scene animations inherit its repeat count instead of hard-coding one play.
Closing guidance pauses and unmounts its scene. The panel entrance plays once;
its characters and objects keep moving while shown. Standalone settled scenes
retain their brief gesture, while real progress repeats for its state's lifetime.

Reduced motion uses each scene's **explicit informative static pose**. Disabling
animation alone is insufficient if the base SVG hides the result or shows a
misleading starting pose. Settled facts stay visible during decorative movement.
Static styling is scoped to its SVG; one still tooltip must not freeze another
progress scene. Action demonstrations play forward, hold their result, then
replay; a direct cut back to the opening pose is acceptable. Seamless loops are
optional. Do not add a reverse action, extra bounce or fade just to match the
first and last frames. Natural blinking, hopping and peeking can return to rest
as part of the gesture. Keep movement brief and give the explanation quiet time.

Every comic surface, including overlays and error pages, needs visible motion
in its subject: a paused scene's steam rises, a loose cable sways, or packets
advance toward a bottleneck. Whole-scene entrance, blinking or sparkle alone
does not satisfy this. Settled result marks stay readable during that movement.
Changing the comic's meaning starts its animation afresh; changing a caption,
language or numeric value alone does not. The preview's reduced-motion setting
uses the same explicit final poses as the system setting.
Check scenes in isolation, including settled overrides and quick re-entry while
a tooltip is exiting, so another mounted scene cannot hide missing CSS or a
finished animation. Reduced-motion rules must outrank settled-motion overrides.
Also check the actual controls together, in every relevant property combination.
Judge motion at its displayed size: a changing transform on a tiny figure can
still look frozen. The default scene catalogue does not cover a Pill's settled
override or missing preview states by itself.

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
pseudo-lettering tied to the same line. Hide that visual cipher from assistive
technology; the ordinary text sentence remains readable. Switching between text
and visual mode preserves the selected welcome entry; rotation follows the
[shared lifecycle](#playful-copy-lifecycle). The line never replaces an action,
error, loading message or connection progress. Keep it on one line, apart from the actions; primary controls take
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
  establish visual clarity. Judge the actual tooltip size, not only an enlarged
  SVG. Improve staging, gaze and timing before enlarging figures or adding props
  and effects; remove additions that do not help the meaning or the gesture.
- Update this owner when accepting a new convention. Product documents link
  here instead of copying the palette, cast or animation table.

## Interaction References

[Carbon status indicators](https://v10.carbondesignsystem.com/patterns/status-indicator-pattern/)
supports combining semantic colour with shape and symbols;
[Carbon motion](https://carbondesignsystem.com/elements/motion/overview/)
distinguishes functional feedback from occasional expressive movement.

[Web Animations start time](https://developer.mozilla.org/en-US/docs/Web/API/Animation/startTime)
provides the native timeline alignment used by participant gestures.

[Carbon tooltip guidance](https://carbondesignsystem.com/components/tooltip/usage/)
supports concise, contextual help where it adds information; required instructions
stay visible beside the action.
[W3C hover/focus guidance](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html)
supports panels remaining reachable for reading and being dismissible without
moving the pointer away.

[Carbon loading guidance](https://carbondesignsystem.com/components/loading/usage/)
supports avoiding competing indicators and keeping required user actions distinct
from passive loading. Piik's immediate captions and eight-second cadence are its
own presentation choice.
