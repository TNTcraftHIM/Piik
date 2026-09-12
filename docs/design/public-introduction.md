# Public introduction

This file owns the website and README content structure. The
[visual language](./visual-language.md) owns their shared illustration and motion.

## One story, three readers

Lead with friends sharing something worth seeing: a game, a drawing, a film or
travel photos. The [copy guide](../reference/naming.md#voice-and-terminology) owns
Chinese/English voice and role labels. A visitor should
understand what Piik does, choose an entry and complete the first useful action.

| Surface | Reader's question | Content |
| --- | --- | --- |
| README, English and Chinese | What is this, and how do I start? | Brand introduction and interface preview, features, getting started, self-hosting, contribution and license |
| `site/`, for GitHub Pages | What does using it feel like, and how do I start? | Room illustration and primary download link, illustrated steps, demo/App/existing-site walkthroughs, FAQ, platform downloads, documentation and source |
| Getting-started guides | Which button or mode do I use? | Browser invitation, sharing, App setup and three mode choices |
| Self-hosting guides | How do I put my own site online? | Run the binary, set the domain and HTTPS proxy, open ports and verify; service management remains a separate reference |
| Developer and operations docs | How do I build or host it? | Existing configuration, deployment, architecture and diagnostic owners |

The [documentation map](../README.md) is the Wiki-style entry. Link it from the
website navigation and footer, with direct self-hosting, configuration and
update/recovery links in the documentation section. Keep the guides in this
repository; do not maintain a second GitHub Wiki copy of the same instructions.

## Presentation

Keep three presentation responsibilities distinct:

| Layer | Owns | Review question |
| --- | --- | --- |
| Shared identity | Mascot geometry and wink, gold sparkle, wordmark/orange dot, public-page brand control | Does this read as the same Piik at every size and entry? |
| Product demonstration | Actual components, labels, source selection, room controls and participants with sample data | Does the pictured action still match the current product? |
| Promotional composition | Original scenery, large typography, framing, transitions and optional music | Does the spectacle help a newcomer understand the product and find the next action? |

Use one public-page brand component for the homepage and film. The mascot's
curved wink and gold sparkle are recognizable features; a prop or a pictured
game does not replace its face with another expression. Original RPG scenery
can suggest exploration through terrain, ruins and small discoveries without
borrowing another product's characters, named places, logos or artwork.

Homepage sections follow the visitor's decisions: understand Piik and find the
primary download action, see the sharing steps, choose a short tutorial, resolve
questions, then find platform downloads, detailed documentation and source.
The primary download link lets returning visitors skip the tutorials. Guide
choices run from online demo to App to an existing site, with only the demo
expanded initially. Watching requires no installation. Explain where an existing
site comes from; mark self-hosting as advanced and link its complete guide.
Platform download cards share one App tutorial entry. Keep section navigation
available on phones rather than hiding the only route to documentation.
The film can use bolder composition, but must show real operations and concrete
benefits before its closing action. The [copy guide](../reference/naming.md#voice-and-terminology)
owns technical disclosure; a dramatic heading does not exempt copy from it.

Review whole Chinese phrases, English meaning and adjacent number labels in
finished frames, not just the source string. Recheck the smallest viewport and
both languages when changing a title or its timing. Keep enough still time to
read it; do not solve overflow by shrinking an important caption beyond legibility.

Use the [shared visual language](./visual-language.md) for cast, objects,
accessible interaction and motion. This document owns the website's editorial
layout and introduction, not a separate product-status vocabulary.

Each section needs one reader question, evidence that answers it and a clear
next action. A scene should demonstrate one action or benefit before changing
the topic. Keep decorative words and transitions away from control labels and
the primary action; sound and motion must not carry essential instructions alone.
Gameplay reactions follow a visible result: establish the action, show its
success, then celebrate. Keep enough of the play visible to make the reaction
understandable; a genre label or a score burst does not replace the action.

Use mint walls, clear control edges, a warm orange/yellow sofa and the curious TV
mascot. The site is a welcoming room, not a monitoring dashboard. Keep one
primary action, native navigation and short instructions. Language and theme
follow the system unless explicitly changed; unsupported languages use English.
Respect reduced motion and retain useful content without JavaScript.

The room illustration cycles through four distinct uses: an RPG, drawing,
travel photos and a movie. Treat coding and design as creative work rather than
proliferating overlapping examples. The host holds a gamepad during the game;
the role badge identifies the host independently of the activity.
Keep participant drawings consistent across the site, READMEs,
interface captures and tooltip/status comics.

Present Piik as an open-source project: plain explanations, room for tinkering,
and an invitation to contribute. Keep the friendly illustration and avoid
company-style pitches, repeated slogans or claims about a support team.
The short comics illustrate choosing, inviting and joining, following the
shared motion grammar and whole-control replay rule. The optional film starts
only after an explicit action and has native buttons and a seek slider. Open it
within the homepage, loading its single player on demand; closing it unloads
playback. The standalone page serves recording and direct links. Fullscreen
watching keeps touch controls available; hiding them is an explicit recording action.
Both READMEs share the friendly opening and room illustration. Their feature,
limitation and setup sections use the factual register in the copy guide.

Use a consistent README structure:
a distinct brand opening, bold headings and key phrases, regular explanatory
text, quiet captions and optional detail. Use images and short demonstrations
to explain different things rather than filling space. Keep essential setup and
availability in readable text, and distinguish generated demo content from a
real captured workload. GitHub-native Markdown/HTML must remain useful on mobile
and in both themes without custom CSS.

The product UI remains mascot-only. On the website, keep the header's TV
mascot before the Piik name. The wordmark and mascot do not transform
into one another. Match the product's
playful style through the mascot's wink and short comic interactions. An
original room illustration is shared by the site and READMEs. Interface previews
use generated scenes and sample participants. Keep private invitations,
user identities and personal media out of published assets; no external fonts
or tracking are needed.

## Small implementation

The website and film initially follow the browser's primary language: Chinese
uses Chinese copy, and other languages use English. An explicit language choice
is shared between these two pages and remembered; linked language choices take
precedence when following a link.

Use static HTML, CSS, SVG and small scripts for the public pages; no router,
CMS, translation dependency or new application backend. The film's isolated
demonstration frame bundles the existing React product components and styles,
using staged inputs. It cannot access storage, run capture or contact the room
service. The film clock owns its actions and decorative CSS animation positions.
Rebuilding the site picks up component/style/copy changes; changes to the actual
workflow still require reviewing the sequence and camera framing. Do not replace
shared controls with a second hand-drawn UI or retain obsolete screenshot plates.
The existing App/Web
continues to own sharing. The homepage explains it rather than simulating a
second room authority. Public copies of advanced product/research documents
are not automatically included in the website artifact.

The [website operations guide](../operations/website.md) owns Pages publication,
public destinations and the separate P2P-only demo. The primary action leads
to the platform download section. Each supported platform has a direct ZIP link
using GitHub's native latest-release asset route. Build verified Gitee links from
the matching release and source revision, showing the mirror's specific version.
Keep release notes separate; when a mirror package is unverified, label its
fallback as a release-page link. Verify destinations as part of publication.
Demo, App and existing-site walkthroughs
use real action names and explain the first sharing and viewing steps. Keep
platform requirements and connection limitations beside the relevant steps.

## Review boundary

Review desktop/mobile, English/Chinese, light/dark, keyboard navigation,
reduced motion, no JavaScript and a nested project URL. Check links, accurate
platform/connection claims and a single copy of each responsibility. Remove
decorative controls or code that do not improve understanding. This is a public
introduction overhaul, not an excuse to change configuration or media policy.
