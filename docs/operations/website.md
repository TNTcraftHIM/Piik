# Public website

The website source is `site/`. It explains Piik; it does not run rooms, signaling
or media. The [public introduction guide](../standards/public-introduction.md) owns
its content and design boundary.

## Public Destinations

| Entry | Destination |
| --- | --- |
| Website | [piik.tv](https://piik.tv) |
| P2P-only demo on the separate US server | [demo.piik.tv](https://demo.piik.tv) |
| App downloads and release notes | [GitHub Releases](https://github.com/TNTcraftHIM/Piik/releases) |
| Download mirror for domestic access | [Gitee Releases](https://gitee.com/TNTcraftHIM/Piik/releases) |
| Documentation source | [Reader guides](../guide/README.md), with a separate [developer map](../README.md) |

GitHub Pages serves `piik.tv` behind
Cloudflare; both the GitHub origin and Cloudflare edge use HTTPS. Website and
Demo HTTP traffic use proxied DNS with origin cache headers respected.
The separate `stun.piik.tv` hostname stays DNS-only for direct UDP connectivity.

GitHub Pages can serve the complete website: it hosts
[static HTML, CSS and JavaScript](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).
The demo also needs the Go service for room authority, WebSocket signaling and
UDP STUN, so it runs on the separate US server rather than Pages.

### Managed Hosting Assessment

Reviewed 2026-10-07. Keep the current deployment for this candidate. A managed
container can reduce host administration, but must preserve public UDP, stable
room authority and SQLite storage. [Fly.io supports public UDP](https://docs.fly.io/networking/udp-and-tcp)
with a dedicated IPv4 address and a specific UDP bind address; external and
internal UDP ports must match. Its [dedicated IPv4 charge](https://docs.fly.io/about/pricing)
is $2/month before compute, storage and transfer. This is a possible deployment
target, not an established cost saving over the current server.

[Cloudflare Containers disks are ephemeral by default](https://developers.cloudflare.com/containers/faq/#is-disk-persistent-what-happens-to-my-disk-when-my-container-sleeps).
Snapshots or object-backed storage are not a drop-in replacement for the current
live SQLite contract. No provider migration is accepted; compare the complete
cost and verify storage, UDP and restart behavior before changing the Demo.

## Public Demo Configuration

The chosen demo allows entry without a site password and provides P2P sharing
without SFU fallback. Use the [self-hosting runbook](./self-hosting.md) with:

```dotenv
PIIK_ENV=production
LISTEN_HOST=127.0.0.1
PORT=8787
PUBLIC_BASE_URL=https://demo.piik.tv
ALLOWED_ORIGINS=https://demo.piik.tv
SITE_ACCESS_PASSWORD=
ROOM_DATABASE_PATH=/var/lib/piik/rooms.sqlite
ROOM_EMPTY_TIMEOUT_SECONDS=3600
MAX_VIEWERS_PER_ROOM=20
STUN_URLS=stun:stun.piik.tv:3478
NAT_PREDICTION_ENABLED=true
SFU_UDP_PORT=
```

Point both hostnames at the US server: proxy `demo.piik.tv` through Cloudflare,
but leave `stun.piik.tv` DNS-only. Allow UDP 3478/3479/3480 directly to the server;
Cloudflare's ordinary HTTP proxy does not carry STUN. Caddy terminates origin
HTTPS/WSS. The demo uses the
standard [systemd service](./service-management.md#systemd), with its release
under `/opt/piik/current` and configuration at `/etc/piik/piik.env`. The service
unit provides the SQLite state directory. Room ownership, invitations and private-room
admission still apply. The [configuration reference](../standards/configuration.md)
owns each setting and its bounds.

The Demo's Caddy proxy compresses `/assets/*` with zstd/gzip. Successful
content-hashed JavaScript and CSS responses use
`Cache-Control: public, max-age=31536000, immutable`; other responses default to
`no-store`. Match both the hashed filename and a successful response status so
a missing bundle cannot acquire the long cache lifetime. Keep HTML, room APIs,
health responses and signaling outside static caching. New bundles have new
filenames; do not publish different bytes under an existing hashed URL.
Cloudflare caches those static bundles; HTML and API responses remain uncached,
and WebSocket signaling passes through to the same room authority. Changing the
HTTP delivery path does not enable SFU or proxy peer media.

For updates, follow the [application release boundary](../deployment.md#release-boundary)
and its artifact verification, health checks and recovery rules. Routine application
rollback restores the previous executable while keeping current room data. This
Caddy installation needs a scoped updater; the nginx-specific maintainer wrapper
does not manage it.

## Maintenance

Website HTML bypasses Cloudflare's edge cache and sends `Cache-Control: no-cache`
so Browsers revalidate it. Content-hashed scripts, styles and images keep their
ordinary cache policy. This keeps an older homepage from referring to assets
removed by a later Pages deployment. These rules match only the website hosts;
the Demo has its own cache owner above.

Copy [the maintenance example](./maintenance.env.example) to
`.env.maintenance.local` in the checkout and fill in local credentials and targets.
The file is ignored by Git. Use Node's built-in env-file option:

```sh
node --env-file=.env.maintenance.local scripts/release-maintenance.mjs website-check
node --env-file=.env.maintenance.local scripts/release-maintenance.mjs website-purge
node --env-file=.env.maintenance.local scripts/release-maintenance.mjs server-check
```

The website check reads the two rule phases, checks fresh HTML and compares the
root/index asset references. Purge removes only those website entry points from
Cloudflare; it cannot clear visitors' Browser caches. The Server check uses SSH
to inspect the managed Linux `piik` service, its running package and public health.
It changes no service, firewall or configuration. Keep separate ignored env files
for different Server targets, or use existing SSH aliases; do not copy private
connection details into the scripts. [Server deployment](../deployment.md) owns
package upload, atomic cutover and recovery; these checks do not replace it.

Rule changes remain explicit infrastructure work: save the current rule phases
and define their scoped rollback before modifying them. The maintenance commands
do not rewrite rules or manage DNS. See Cloudflare's
[cache-rule order](https://developers.cloudflare.com/cache/how-to/cache-rules/order/)
and [response-header rules](https://developers.cloudflare.com/rules/transform/response-header-modification/):
edge eligibility and the Browser's cache header have separate owners.

## Preview

With the repository's development dependencies installed:

```sh
npm ci --prefix site/docs
npm run build:website
npm run preview:website
```

Open `http://127.0.0.1:18890`. Rebuild after editing source. The build bundles the
film's real product components into an isolated demonstration frame; publishing
`build/site/` needs no Node runtime or backend. Vite preview supplies HTTP byte
ranges for seeking the soundtrack. Keep asset links relative so both a custom
domain and GitHub's `/Piik/` project path work. For a nested deployment, set
`PIIK_DOCS_BASE=/Piik/docs/` when building; ordinary custom-domain builds use `/docs/`.

The homepage, film and demonstration frames use content-hashed script/style
bundles. Their HTML references come from the same build, including imported
dependencies; fixed filenames must not mix a new page with cached old controls
or styles. Publish the complete output together.

Favicons share the [App artwork and exports](../../cmd/piik-app/DEVELOPMENT.md#desktop-icons).
The website build copies the public SVG/PNG/ICO assets for the homepage, film
and documentation, keeping their URLs stable.

[Google's favicon guidance](https://developers.google.com/search/docs/appearance/favicon-in-search)
requires a crawlable homepage and icon, and supports one favicon per hostname.
The PNG/ICO links make the brand available to search crawlers; indexing and
display are not guaranteed. A repository under `github.com` cannot set its own
search favicon independently of GitHub.

## Documentation Build

`site/docs/` configures VitePress; its isolated package and lockfile keep document
tooling out of the App/Server dependency tree. The pinned Vite override follows the
[VitePress maintainer's guidance](https://github.com/vuejs/vitepress/discussions/5072)
to use the security-maintained Vite 6 line with stable VitePress 1. Remove the
override when a stable upstream release supplies a maintained version directly.

The explicit list in `site/docs/pages.mjs` maps original Markdown files to public
routes and sidebar labels. `build.mjs` stages only those files under ignored
`build/docs-source/`, then emits `build/site/docs/` as part of `build:website`.
Edit the original Markdown, never a staged copy. Relative links between published
pages become local web links; references outside the list continue to GitHub.
Heading IDs reuse the repository checker's GitHub-style slug rule, so section
links work in both views without a second set of anchors.
The page edit link targets its original source. Developer context, TODO, research
and operational release records are not automatically published as reader pages.

The docs keep paired English/Chinese guides, shared site language preference,
system/explicit appearance and the existing mascot. Search uses a local index
and native word segmentation for Chinese and English, with no hosted search service.
Technical configuration keeps its existing English owner on GitHub.

Both homepage and documentation are uploaded in the same Pages artifact. Do not
run a second Pages deployment that would overwrite the homepage. Website/docs
sources and the nested package remain outside product-release paths; shared
product code and App/Server build inputs still follow the release boundary.
Check links, language switching, search, keyboard/mobile use and the static
HTML fallback when changing the public documentation.

### Guide screenshots

With `agent-browser` installed, start `npm run dev -- --host 127.0.0.1`.
After changing pictured controls or copy, run in another terminal:

```sh
node scripts/update-guide-images.mjs http://127.0.0.1:5173
npm run build:website
```

The script first regenerates the audio-path diagrams from the product icon and
palette owners, then captures `/__tooltip-preview` production components with sample data,
both languages, light/dark themes and reduced motion, then closes its own session.
It crops to the mode selector, source picker, sharing settings, voice panel and
sample sharing-failure dialog;
keep each capture beside the task it explains. Markdown uses GitHub's
`#gh-light-mode-only` / `#gh-dark-mode-only` image hints, which the documentation
theme also follows when its appearance control changes. Do not invert or tint
screenshots: capture the actual theme. SVG explanations inherit the page's
colour scheme and remain sharp at smaller sizes. `scripts/update-guide-diagrams.tsx`
generates the audio-path SVGs and embeds the shared palette in the three-step
illustration; `build:website` checks these generated parts for source freshness.
Adjust capture viewport/panel size to show complete choices and avoid unused space;
do not edit controls or labels inside the saved image.
`AGENT_BROWSER_PATH` overrides the CLI path. Inspect `docs/assets/guide/` before
committing with UI/copy changes. Keep example captions; use no live-room data,
hand-edited text or duplicate mockups.

The build stages `docs/assets/` and rewrites Markdown image paths to hashed URLs.
GitHub and the docs center share the sources; README links to the full tutorial.

To refresh the README's four room PNGs in the same run, pass an already-built
website preview as the second URL:

```sh
node scripts/update-guide-images.mjs http://127.0.0.1:5173 http://127.0.0.1:18890
```

Build that preview from the current UI first. The README captures use the
[film's real-component fixture](../../site/film/README.md), with sample people
and generated game artwork. The room illustration and quickstart SVG are
authored explanations, not screenshots.

`build:website` bundles current components and guides and checks the generated
hero artwork; it does not take screenshots. `check-docs.mjs` checks local
Markdown/HTML image targets and document links, not screenshot freshness or
visual accuracy. Refresh affected PNGs with the capture command, inspect them,
then rebuild to publish updated guide assets.

## Downloads

The Windows, macOS and Linux App cards use fixed filenames and each provider's
native latest-attachment route:

- GitHub: `releases/latest/download/asset-name.zip`
  ([documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)).
- Gitee: `releases/download/latest/asset-name.zip`
  ([Windows download](https://gitee.com/TNTcraftHIM/Piik/releases/download/latest/piik-app-windows-amd64.zip)).

Both links follow provider publication without a website rebuild. Supported App
architecture choices stay visible; one selection updates both providers' links.
An optional GitHub metadata request supplies the latest version/date and its
authored editorial title and one-line explanation;
failure does not disable architecture selection. Without JavaScript, the default
links remain Windows x64, Apple silicon and Linux x64. Publish a newly listed App
package before deploying its website option. ARM64 Server packages alone do not
enable an ARM64 App choice.
Platform buttons say “Download from GitHub” /
“GitHub 下载”; the secondary link says “Download from Gitee” /
“Gitee 国内镜像下载”. Keep versions and archive formats out of these labels.
[Versioning](../standards/versioning.md#release-sources) owns package verification
and completion of mirror publication. GitHub remains the primary source; the
Gitee download can temporarily lag while a mirror publication completes.
Verify the latest redirects and package checksums after releases.

## Publish

1. Verify the public copy and destinations above, publish the release artifacts
   and open the source repository as part of the approved public launch.
2. In repository **Settings > Pages**, choose **GitHub Actions** as the source.
   Use the dedicated Pages workflow, not publication of the repository root or
   all of `docs/`, which includes developer research and operational reference.
3. Set the approved `piik.tv` custom domain in Pages settings and configure its
   DNS using GitHub's [current domain instructions](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).
   Actions publishing does not need a `CNAME` file in the source tree.
4. Accepted main pushes run CI first; success triggers **Website**, which checks
   out that CI run's exact commit. Manual dispatch uses its selected `main` commit.
   Before publishing, both paths skip a build that is no longer current main;
   dispatch again for the latest commit when needed. The separate Gitee mirror
   workflow does not gate Website deployment. Download links resolve through each provider, so
   publishing a package or retrying its mirror needs no link refresh.
   Only `build/site/` is uploaded; website work does not package App/Server.
   Verify HTTPS, both languages, relative assets and per-platform download links.

Branch/PR pushes do not deploy. The workflow does not change DNS; the private
production site and the US P2P-only demo remain separate deployments.

For rollback, dispatch the previously accepted site revision from a reviewed
revert on `main`; runtime App/Server binaries and databases are unaffected.
