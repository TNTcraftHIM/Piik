# Piik rename

Status: accepted rename and coordinated cutover plan.
Last reviewed: 2026-09-10.

## Accepted identity

Display `Piik`; use `piik` for executable, package, environment and service
identifiers. GitHub is `TNTcraftHIM/Piik`; the Go module follows that exact case.
The native macOS bundle identifier is `tv.piik.client`.
The product keeps its TV mascot. The wordmark and morph animation remain in the
[brand study](../design/piik-brand.html) for the future public website.

This is a private pre-release rename. It changes names and deployment identity,
not media policy, routing, capture behavior or SQLite room semantics.

## Recovery and local metadata

The external `Piik-recovery/rename-20260910` directory contains a verified
`repository.bundle` and a complete `git-metadata` copy. The latter preserves
reflogs and all ten stash entries, which a bundle of ordinary refs alone does
not capture. Earlier recovery bundles also remain outside the repository.
Backups keep their original names and contents so they remain identifiable.

The main directory is `Piik`; preparation worktrees are `Piik-appearance` and
`Piik-rename`, with `Piik-external-audit` retained separately. Their private Git
registration names, backlinks and shared remote are updated. The hook path is
relative `.githooks`. Retire integrated preparation worktrees after cutover.
The audit worktree's branch and source revision remain untouched. Integration
keeps one complete phase commit on main.

On Windows, a terminal can hold the repository directory open. Move the entries
into an empty verified destination and run `git worktree repair` from the new
main directory. Do not terminate the user's terminal to release a path.
Existing firewall rules name executable paths, so moved build binaries require
their corresponding path rules to be reviewed before network acceptance.

## Runtime and data boundary

`piik-v23` and `piik-client-v9` are new exact protocol labels. Their message
schemas retain versions 23 and 9; the full label, not only its numeric suffix,
is checked. Native capture remains v7. Release Web, Server, Client and capture
artifacts together; old pages and installed Clients cannot interoperate across
the renamed control boundary. No alternate protocol reader is introduced.

SQLite schema 2, its application ID, room codes, token/grant digests and password
material remain unchanged. The four-byte database file identity is a format
constant, not display branding. Copy the database only while the old process is
stopped, verify integrity and retained columns, and preserve the original for
rollback. Do not recreate rooms or repeat the earlier schema-1 cutover.

The implementation renames Browser storage prefixes, the site-access cookie
and the Client configuration/cache directory. The owner accepts a clean break:
copy directly compatible, accessible settings once during cutover; discard
unavailable or incompatible settings. The product reads only Piik names, with
no migration code, alternate reader or old-name alias.

The local Client configuration is unchanged JSON version 1 and can be copied
byte-for-byte into the Piik directory without replacing an existing new config.
Browser credentials and settings are origin/session-owned. Transfer them only
through an available original Browser session; do not modify a live Browser's
storage database or introduce a product bridge to recover them. Otherwise the
new namespace starts empty, requiring login, room creation and preference setup.
Old room authority remains in SQLite, but an unavailable Host credential cannot
be reconstructed from its stored digest. Site-access cookies and remembered
Client activation are renewed normally under the new contract.

## Git history

The owner authorized replacing the old name in Git history. Use the maintained
`git-filter-repo` tool in a fresh, separate bare clone, never in the working
repository. Scope this to commit/tag **messages**: historical source snapshots,
authorship, dates and topology remain factual. Current tracked prose and code
use the accepted identity; old snapshots remain recoverable at their mapped
commits and in the original archive.

The initial inventory found two matching commit bodies and no matching commit
subjects or tag names. A small text change still changes descendant SHAs and
invalidates their commit signatures. Preserve `commit-map` and `ref-map`; verify
equal commit counts, identical source trees, mapped parents, authors and dates,
no dropped commits and a clean repository integrity check. No replacement refs,
duplicate compatibility branches or history-rewriting tool enter the product.

The rehearsal verified all 546 reachable branch/tag commits: exactly two messages
changed, all file trees and mapped parent relationships match, and authors/dates
are preserved. Standard filtering rewrote 545 IDs and removed 374 signatures.
Those signatures remain verifiable only in the original archive; a rewritten
commit must not be presented as preserving its earlier GitHub verification.

Apply a reviewed message rewrite only with the coordinated brand integration,
using explicit ref targets and old-SHA leases. Do not use `push --mirror` from
the rehearsal: it could overwrite unrelated refs. Preserve the external audit
branch and stash history in the original repository. Old audit/deployment SHAs
remain evidence identifiers, interpreted through the archive and commit map.

## Operational cutover

The following old identifiers are retained here only as operator recovery
inputs, not as runtime aliases:

| Surface | Before | After |
| --- | --- | --- |
| Service, user and group | `screener` | `piik` |
| Installation root | `/opt/screener` | `/opt/piik` |
| Environment file | `/etc/screener/screener.env` | `/etc/piik/piik.env` |
| Branded environment prefix | `SCREENER_` | `PIIK_` |
| Browser storage prefix | `screener:` | `piik:` |
| Client config directory | `Screener` | `Piik` |

Prepare the new immutable artifacts, service/environment/proxy configuration,
permissions and database path before stopping the old service. Record original
configuration and ownership for recovery. Do not run two room authorities on
the same database or two media services on the same UDP ports.

The routine `deploy/release-app.sh` assumes an existing **Piik** installation.
It is not the first brand migration tool: its old-release checks and recovery
target the Piik service/binary. Perform the first name cutover as one explicit
infrastructure operation, then use the ordinary wrapper for future releases.
On failure, stop the candidate and restore the old binary, service, environment,
proxy and data together before reopening ingress.

GitHub is already renamed and the remote works. There are no published releases
or Pages site to migrate. Keep repository visibility private; `piik.tv` DNS and
Pages publication remain a separate website task. Old GitHub deployment/PR
records describe earlier operations and are not rewritten as new releases.

## Validation and references

Acceptance covers the tracked-name inventory, Web type/build checks, relevant
contract/storage tests, native compilation, Client/Server packaging and a
controlled local launch. Production release additionally requires the accepted
best-effort settings transfer, configuration/database recovery and postflight.

Primary references, checked 2026-09-10:

- [Git worktree repair](https://git-scm.com/docs/git-worktree): repair both
  directions after moving the main repository or linked worktrees.
- [git-filter-repo](https://github.com/newren/git-filter-repo/blob/main/Documentation/git-filter-repo.txt):
  message replacement, fresh clones and old/new commit maps.
- [GitHub repository rename](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository):
  ordinary URL redirects do not cover repository-hosted Actions or project Pages.
