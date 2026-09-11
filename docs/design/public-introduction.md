# Public introduction

Status: README rewrite and website refinement authorized, 2026-09-11;
local drafts remain subject to owner review.

## One story, three readers

Lead with friends sharing something worth seeing: a game, a drawing or a new
discovery. The [copy guide](../reference/naming.md#voice-and-terminology) owns
Chinese/English voice and role labels. A visitor should
understand what Piik does, choose an entry and complete the first useful action.

| Surface | Reader's question | Content |
| --- | --- | --- |
| README, English and Chinese | What is this, and how do I start? | Brand introduction and interface preview, features, getting started, self-hosting, contribution and license |
| `site/`, for GitHub Pages | What does using it feel like, and how do I start? | Room illustration and primary download link, illustrated steps, Browser/App/demo walkthroughs, FAQ, platform downloads, documentation and source |
| Getting-started guides | Which button or mode do I use? | Browser invitation, sharing, App setup and three mode choices |
| Self-hosting guides | How do I put my own site online? | Run the binary, set the domain and HTTPS proxy, open ports and verify; service management remains a separate reference |
| Developer and operations docs | How do I build or host it? | Existing configuration, deployment, architecture and diagnostic owners |

The [documentation map](../README.md) is the Wiki-style entry. Link it from the
website navigation and footer, with direct self-hosting, configuration and
update/recovery links in the documentation section. Keep the guides in this
repository; do not maintain a second GitHub Wiki copy of the same instructions.

## Presentation

Use the [shared visual language](./visual-language.md) for cast, objects,
accessible interaction and motion. This document owns the website's editorial
layout and introduction, not a separate product-status vocabulary.

Use the existing mint walls, dark outlines, warm orange/yellow sofa and curious TV
mascot. The site is a welcoming room, not a monitoring dashboard. Keep one
primary action, native navigation and short instructions. English is the first
view with an explicit Chinese choice; theme follows the system unless changed.
Respect reduced motion and retain useful content without JavaScript.

Lead the room illustration with a game and a host holding a gamepad. The game
gives the scene movement; the surrounding copy still welcomes drawing, demos
and other screen content. The role badge identifies the host independently of
the activity. Keep participant drawings consistent across the site, READMEs,
interface captures and tooltip/status comics.

Present Piik as an open-source project: plain explanations, room for tinkering,
and an invitation to contribute. Keep the friendly illustration and avoid
company-style pitches, repeated slogans or claims about a support team.
The short comics illustrate choosing, inviting and joining, following the
shared motion grammar and whole-control replay rule. Decorative introduction
loops follow that owner's separate pause/hide and reduced-motion requirements.
Both READMEs share the friendly opening and room illustration. Their feature,
limitation and setup sections use the factual register in the copy guide.

The owner is broadly happy with the website's overall design; retain its visual
direction while improving reading order, motion and copy. Use a familiar README structure:
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
original room illustration is shared by the site and READMEs. Interface captures
use generated scenes and sample participants. Keep private invitations,
user identities and personal media out of published assets; no external fonts
or tracking are needed.

## Small implementation

Use static HTML, CSS, SVG and small scripts in `site/`; no router, framework,
CMS, translation dependency or new application backend. The existing App/Web
continues to own sharing. The homepage explains it rather than simulating a
second room authority. Public copies of advanced product/research documents
are not automatically included in the website artifact.

Use one manual Pages workflow to publish only `site/`. Branch pushes do not
build or deploy it. Local review does not change DNS, repository visibility,
Pages settings or the private production service. The proposed US P2P-only
demo is separate runtime work. The primary action leads to the platform
download section. Prepare the public-launch draft with the final website,
documentation, release-page and demo destinations. Use the permanent GitHub
Releases page for downloads; archive names include a revision. Verify the
destinations as part of publication. Browser, App and demo walkthroughs
use real action names and explain the first sharing and viewing steps. Keep
platform requirements and connection limitations beside the relevant steps.

## Review boundary

Review desktop/mobile, English/Chinese, light/dark, keyboard navigation,
reduced motion, no JavaScript and a nested project URL. Check links, accurate
platform/connection claims and a single copy of each responsibility. Remove
decorative controls or code that do not improve understanding. This is a public
introduction overhaul, not an excuse to change configuration or media policy.

## References

Reviewed 2026-09-11. These inform structure; Piik copy and illustrations are original.

- [Cloudreve](https://cloudreve.org/) and its [README](https://github.com/cloudreve/Cloudreve): a centered identity, features, deployment and contribution, with detailed operations outside the introduction.
- [LocalSend](https://localsend.org/): user benefit followed by a short sequence.
- [LocalSend README](https://github.com/localsend/localsend): a concise purpose and clear user/developer entry points.
- [Excalidraw README](https://github.com/excalidraw/excalidraw): a recognizable visual introduction with a separate product showcase and documentation links.
- [Syncthing](https://syncthing.net/) and its [getting-started guide](https://docs.syncthing.net/intro/getting-started.html): simple executable plus Browser interface, with technical detail elsewhere.
- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages): deploy a selected static directory with the official actions.
- [GitHub Pages scope and availability](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages): static hosting, plan requirements and project URL prefixes.
