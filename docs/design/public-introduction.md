# Public introduction

Status: local draft for owner review, 2026-09-10.

## One story, three readers

Lead with watching a friend's game, not transport terminology. A visitor should
understand what Piik does, choose an entry and complete the first useful action.

| Surface | Reader's question | Content |
| --- | --- | --- |
| README, English and Chinese | What is this, and how do I start? | Mascot, one illustration, watch/share/App entry paths, guide links |
| `site/`, for GitHub Pages | What does using it feel like? | Front-row gaming story, approved wordmark/TV animation, illustrated steps, first-use guide and practical FAQ |
| Getting-started guides | Which button or mode do I use? | Browser invitation, sharing, App setup and three mode choices |
| Developer and operations docs | How do I build or host it? | Existing configuration, deployment, architecture and diagnostic owners |

The documentation map is the Wiki-style entry. Keep it in this repository;
do not maintain a second GitHub Wiki copy of the same instructions.

## Presentation

Use the existing mint walls, dark outlines, warm orange sofa and curious TV
mascot. The site is a welcoming room, not a monitoring dashboard. Keep one
primary action, native navigation and short instructions. English is the first
view with an explicit Chinese choice; theme follows the system unless changed.
Respect reduced motion and retain useful content without JavaScript.

The product UI remains mascot-only. The approved Piik-to-TV stroke animation
belongs on the website, without the brand study's casing experiments or control
panel. An original room illustration is shared by the site and READMEs. No real
room codes, user identities, private media, external fonts or tracking are needed.

## Small implementation

Use static HTML, CSS, SVG and small scripts in `site/`; no router, framework,
CMS, translation dependency or new application backend. The existing App/Web
continues to own sharing. The homepage explains it rather than simulating a
second room authority. Public copies of advanced product/research documents
are not automatically included in the website artifact.

Use one manual Pages workflow to publish only `site/`. Branch pushes do not
build or deploy it. Local review does not change DNS, repository visibility,
Pages settings or the private production service. The proposed US P2P-only
demo is separate runtime work; do not show a working demo/download CTA until
the corresponding destination actually exists. The draft's first action is
an in-page getting-started guide.

## Review boundary

Review desktop/mobile, English/Chinese, light/dark, keyboard navigation,
reduced motion, no JavaScript and a nested project URL. Check links, accurate
platform/connection claims and a single copy of each responsibility. Remove
decorative controls or code that do not improve understanding. This is a public
introduction overhaul, not an excuse to change configuration or media policy.

## References

- [LocalSend](https://localsend.org/): user benefit followed by a short sequence.
- [Syncthing](https://syncthing.net/) and its [getting-started guide](https://docs.syncthing.net/intro/getting-started.html): simple executable plus Browser interface, with technical detail elsewhere.
- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages): deploy a selected static directory with the official actions.
- [GitHub Pages scope and availability](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages): static hosting, plan requirements and project URL prefixes.
