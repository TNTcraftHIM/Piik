# Public website

The website source is `site/`. It explains Piik; it does not run rooms, signaling
or media. The [public introduction guide](../design/public-introduction.md) owns
its content and design boundary.

## Public Destinations

| Entry | Destination |
| --- | --- |
| Website | [piik.tv](https://piik.tv) |
| P2P-only demo on the separate US server | [demo.piik.tv](https://demo.piik.tv) |
| App downloads and release notes | [GitHub Releases](https://github.com/TNTcraftHIM/Piik/releases) |
| Download mirror for domestic access | [Gitee Releases](https://gitee.com/TNTcraftHIM/Piik/releases) |
| Documentation index | [Repository documentation](../README.md) |

These public destinations are live. GitHub Pages serves `piik.tv` behind
Cloudflare; both the GitHub origin and Cloudflare edge use HTTPS. Website DNS is
proxied with strict origin TLS verification and origin cache headers respected.
Demo DNS remains unproxied so its UDP listeners stay reachable.

GitHub Pages can serve the complete website: it hosts
[static HTML, CSS and JavaScript](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).
The demo also needs the Go service for room authority, WebSocket signaling and
UDP STUN, so it runs on the separate US server rather than Pages.

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
MAX_VIEWERS_PER_ROOM=20
STUN_URLS=stun:demo.piik.tv:3478
NAT_PREDICTION_ENABLED=true
SFU_UDP_PORT=
```

Point `demo.piik.tv` directly at the US server so UDP reaches its STUN listeners;
allow UDP 3478/3479/3480 and terminate HTTPS/WSS at Caddy. The demo uses the
standard [systemd service](./service-management.md#systemd), with its release
under `/opt/piik/current` and configuration at `/etc/piik/piik.env`. The service
unit provides the SQLite state directory. Room ownership, invitations and private-room
admission still apply. The [configuration reference](../reference/configuration.md)
owns each setting and its bounds.

For updates, verify the release descriptor and manifest before placing a new
release under `/opt/piik/releases/`. Stop Piik, back up its SQLite state, switch
`current` to the verified release, and restart. Check local/public health,
WebSocket room access and STUN. Keep the previous release and state backup until
acceptance; restore both with Piik stopped if rollback is needed. The nginx-specific
maintainer wrapper does not manage this Caddy installation.

## Preview

With the repository's development dependencies installed:

```sh
npm run build:website
npm run preview:website
```

Open `http://127.0.0.1:18890`. Rebuild after editing source. The build bundles the
film's real product components into an isolated demonstration frame; publishing
`build/site/` needs no Node runtime or backend. Vite preview supplies HTTP byte
ranges for seeking the soundtrack. Keep asset links relative so both a custom
domain and GitHub's `/Piik/` project path work.

Downloads are static links to the latest published GitHub packages, with explicit
Windows x64, macOS Apple silicon and Linux x64 cards. `PIIK_WEBSITE_RELEASE_DATA`
can point the build at a temporary JSON containing the GitHub release and the
same-tag Gitee release with its attachment list. CI supplies this input; the
builder validates version, source identity and platform URLs. A missing/incomplete
GitHub release fails deployment, preserving the current site. An unavailable
mirror retains a labeled release-page link. Local builds without metadata use
release-page links as well; no visitor API call or hard-coded package SHA is needed.

## Publish

1. Verify the public copy and destinations above, publish the release artifacts
   and open the source repository as part of the approved public launch.
2. In repository **Settings > Pages**, choose **GitHub Actions** as the source.
   Use the dedicated Pages workflow, not publication of the repository root or
   all of `docs/`, which includes developer research and operational reference.
3. Set the approved `piik.tv` custom domain in Pages settings and configure its
   DNS using GitHub's [current domain instructions](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).
   Actions publishing does not need a `CNAME` file in the source tree.
4. Accepted main pushes run CI first; its completion triggers **Website**, which
   checks out current main and reads the latest published download metadata.
   Waiting for CI includes its package publication and mirror attempt, so the
   page picks up the resulting release. A CI failure leaves downloads pointing
   to the latest successful public release. Manual **Website** dispatch from
   `main` can refresh links after an operator publication or mirror retry.
   Only `build/site/` is uploaded; website work does not package App/Server.
   Verify HTTPS, both languages, relative assets and per-platform download links.

Branch/PR pushes do not deploy. The workflow does not change DNS; the private
production site and the US P2P-only demo remain separate deployments.

For rollback, dispatch the previously accepted site revision from a reviewed
revert on `main`; runtime App/Server binaries and databases are unaffected.
