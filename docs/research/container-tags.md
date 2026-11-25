# Container Tags Across A Breaking Major

Evidence for one decision at the 3.0 cutover: what the container image's
`latest` tag means afterwards. It is not decided, and the owner will decide it
when the release is prepared. Researched on 2026-11-25 from each project's own
documentation, registry page or issue tracker. Items marked "reported" come
from a secondary source.

## The Situation

The published 2.x Compose file defaults to the `latest` image, and the 2.x
first-install guide does not tell an operator to pin a version. 3.0 reads
different environment variables and a different data layout, and has no
in-place migration. If `latest` moves to 3.0, a routine pull replaces a working
2.x server with a build that cannot read its configuration or its data.

## What The Ecosystem Says

- [Docker Official Images](https://github.com/docker-library/official-images/blob/master/README.md):
  "`latest` really is the default tag". It names the version people should
  use, which need not be the newest: `ubuntu:latest` is the long-term release.
  Version tags should have aliases for a major and a minor line.
- [Docker build practices](https://docs.docker.com/build/building/best-practices/):
  tags are mutable, and a digest is the only exact pin.
- [GitLab](https://docs.gitlab.com/install/docker/installation/): pin a version
  in production, and use `latest` for testing.

## What Projects Did

| Project | At its breaking major | What it cost or prevented |
| --- | --- | --- |
| [InfluxDB 1.8 to 2.0](https://www.influxdata.com/blog/influxdb-latest-tag-updated-in-docker-hub/) | `latest` moved at once | Installs on `latest` landed on a release that could not read their data. The vendor published a correction and said `latest` is not meant for deployments |
| [InfluxDB 2 to 3](https://github.com/influxdata/influxdb/discussions/27136) | 3 shipped under its own tags, `latest` stayed on 2, a date for the move was announced | The date passed and `latest` still names 2. The transition has no visible end |
| [PostgreSQL 18 image](https://github.com/docker-library/postgres/issues/1370) | `latest` moved, and the data path changed | Compose files that mounted the old path stopped. The image now refuses to start on an old layout with a clear message, added after an obscure first failure |
| [Pi-hole 5 to 6](https://github.com/pi-hole/docker-pi-hole/issues/1793) | `latest` moved at once, and nearly every environment variable was renamed | The new version starts with the old variables and ignores them, so it fails as misconfiguration. Requests for a major tag were declined |
| [Traefik 1.7 to 2.0](https://community.letsencrypt.org/t/traefik-docker-broken/102626) | `latest` moved at once | Installs that updated automatically broke on incompatible configuration |
| [Nextcloud](https://github.com/nextcloud/docker/issues/2015) | `latest` follows the newest major, and a `stable` tag stays one major behind | The image compares a version marker in the data with itself and refuses a skipped major or a downgrade, with the reason |
| [Forgejo](https://forgejo.org/faq/) | Publishes no `latest` at all, only major, minor and exact tags | "Upgrading from a major version requires a manual operation and human verification." People keep asking for `latest` |
| [Elasticsearch](https://hub.docker.com/_/elasticsearch) | Publishes exact versions only | "The latest tag is not supported" |
| [authentik](https://docs.goauthentik.io/install-config/install/docker-compose/) | Its Compose file names an exact version | A pull never changes the version. Each upgrade is a new Compose file |

The outcome closest to ours is Pi-hole: renamed variables that the new version
silently ignores.

## Guard Rails

- **In the new major.** PostgreSQL, Nextcloud, GitLab and MongoDB refuse old or
  incompatible data at startup with a message a person can search for, in
  place of failing obscurely or starting empty. Each needs something to
  detect: a version marker in the data, or a known old path or variable.
- **In the old line.** No project was found whose last release of the old
  major prepared the move, by pinning its own default or printing a notice.
  That is not found, not ruled out.
- **Automatic updaters.** Watchtower follows whatever the tag names, so it
  crosses a major on `latest` and stays inside one on a major tag. Its
  maintainers did not recommend it for production, and the repository was
  archived in December 2025. Renovate and Dependabot propose version changes
  for a person to accept.

## The Options

| Option | Chosen by | Cost |
| --- | --- | --- |
| Move `latest` at release, with no guard | InfluxDB in 2021, Traefik, Pi-hole | Every one produced public reports of broken installs |
| Move `latest` at release, and have the new major refuse old data or configuration clearly | PostgreSQL, Nextcloud, GitLab, MongoDB | The service still stops on a pull. The data is untouched and the operator can pin the old tag |
| Keep `latest` on the old major for a time, ship the new major under its own tags, announce a date | InfluxDB in 2026; Nextcloud's `stable` in a lighter form | The date becomes the same break later, and new people who follow `latest` get the old product |
| Offer no `latest`: major, minor and exact tags only, and install files that name a major | Forgejo, Elasticsearch, authentik | A slower first start. Retiring an existing `latest` does not move installs that already follow it |
| A new image name for the new major | No clean case found | Splits documentation and discovery |

The options combine. Every case without a startup refusal surfaced as
confusion, whatever its tag policy.

## Not Verified

The later dates of the InfluxDB move and the reason for its delays, the wording
of Traefik's notice in 2019, and several quotations attributed to Immich and
Pi-hole maintainers were reported second-hand and are left out above.
