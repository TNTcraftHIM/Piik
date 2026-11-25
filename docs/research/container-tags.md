# Container Tags Across A Breaking Major

Evidence for one decision at the 3.0 cutover: what the container image's
`latest` tag means afterwards. It is not decided, and the owner will decide it
when the release is prepared. Reviewed 2026-11-25 from project documentation,
image definitions, source code and firsthand operator reports.

## The Situation

The published 2.x Compose file defaults to the `latest` image, and the 2.x
first-install guide does not tell an operator to pin a version. 3.0 reads
different environment variables and a different data layout, and has no
in-place migration. If `latest` moves to 3.0, pulling and recreating the service
replaces a working 2.x server with a build that cannot read its configuration
or its data.

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
| [InfluxDB 2 to 3](https://github.com/influxdata/influxdb/discussions/27136) | 3 shipped under its own tags, `latest` stayed on 2, a date for the move was announced | The [Official Images definition](https://github.com/docker-library/official-images/blob/master/library/influxdb) still assigns `latest` to 2.x |
| [PostgreSQL 18 image](https://github.com/docker-library/postgres/issues/1370) | `latest` moved, and the data path changed | An operator reported a container-runtime mount failure. The [entrypoint](https://github.com/docker-library/postgres/blob/master/docker-entrypoint.sh) separately refuses detected old databases before initialization |
| [Pi-hole 5 to 6](https://github.com/pi-hole/docker-pi-hole/issues/1793) | `latest` crossed into v6. The [migration guide](https://docs.pi-hole.net/docker/upgrading/v5-v6/) lists renamed and removed variables | One operator reported manually repairing their configuration. The maintainers advised reviewing release notes and disabling automatic upgrades |
| [Traefik 1.7 to 2.0](https://community.letsencrypt.org/t/traefik-docker-broken/102626) | An operator reported an automatic `latest` update to 2.0 | The [v2 documentation](https://doc.traefik.io/traefik/v2.0/getting-started/configuration-overview/) confirms the configuration incompatibility. The operator also reported a configuration parser error |
| [Nextcloud](https://github.com/nextcloud/docker/issues/2015) | `latest` follows the newest major, and a `stable` tag stays one major behind | The [entrypoint](https://github.com/nextcloud/docker/blob/master/docker-entrypoint.sh) compares installed and image versions, refuses a skipped major or a downgrade, and permits a one-major upgrade |
| [Forgejo](https://forgejo.org/faq/) | Publishes no `latest` at all, only major, minor and exact tags | "Upgrading from a major version requires a manual operation and human verification." |
| [Elasticsearch](https://hub.docker.com/_/elasticsearch) | Publishes exact versions only | "The latest tag is not supported" |
| [authentik](https://docs.goauthentik.io/install-config/install/docker-compose/) | The [published Compose file](https://docs.goauthentik.io/compose.yml) defaults to an exact authentik release tag, with an override | The default selects a release independently of the `latest` alias |

Pi-hole provides a configuration example for Piik. The operator report
establishes a broken upgrade, and the migration guide identifies variables
that need replacement or removal.

## Guard Rails

- **In the new major.** PostgreSQL checks detectable old layouts before
  initializing a database. Nextcloud checks version markers before copying
  application files. These checks report incompatible state when recognized.
  Recovery still depends on the project and the deployed state.
- **In the old line.** No project was found whose last release of the old
  major prepared the move, by pinning its own default or printing a notice.
  That is not found, not ruled out.
- **Automatic updaters.** [Watchtower](https://github.com/containrrr/watchtower) can recreate a container
  with a new image behind its configured tag. Its maintainers discouraged
  production use and [archived it in December 2025](https://github.com/containrrr/watchtower/discussions/2135).

## The Options

| Option | Chosen by | Cost |
| --- | --- | --- |
| Move `latest` across an incompatible major | InfluxDB 1.8 to 2.0, Traefik, Pi-hole | The cited accounts document unexpected or broken upgrades |
| Refuse detectable incompatible data or configuration at startup | PostgreSQL, Nextcloud | A refusal can prevent initialization or upgrade on the detected layout. The service remains unavailable if the incompatible image has already replaced it |
| Keep `latest` on the old major for a time, ship the new major under its own tags, announce a date | InfluxDB 2 to 3 | Existing and new `latest` users stay on the older line until the alias moves |
| Offer versioned tags without `latest` | Forgejo, Elasticsearch | The operator chooses a line or a release at installation |
| A new image name for the new major | No clean case found | Splits documentation and discovery |

The reports establish that an incompatible retag can disrupt deployments.
They do not establish the frequency of breakage or a universal outcome.
Keeping a deployment on a versioned tag controls which build it receives.
A startup check controls what the selected build does with detected state.

## Not Verified

The later dates of the InfluxDB move and the reason for its delays, the wording
of Traefik's notice in 2019, and several quotations attributed to Immich and
Pi-hole maintainers were reported second-hand and are left out above.
