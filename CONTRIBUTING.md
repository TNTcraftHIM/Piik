# Contributing

## Ways To Help

Corrections, translations, bug reports and code contributions are welcome.
English and Chinese are both welcome in issues and PRs.
欢迎用中文或英文参与讨论，从一处文案修正或一次问题反馈开始也很好。

| Contribution / 参与方式 | Start here / 从这里开始 |
| --- | --- |
| Translate or improve wording / 翻译、校对文案 | [Translation guide](./docs/guide/translating.md) · [中文翻译教程](./docs/guide/translating.zh-CN.md) |
| Report a bug / 反馈问题 | [Issue templates](https://github.com/TNTcraftHIM/Piik/issues/new/choose); include version, environment, steps and actual result / 附版本、环境、步骤与实际结果 |
| Improve a guide / 改进教程 | [Documentation map](./docs/README.md); identify the confusing step and explain the expected result / 指出不清楚的步骤及预期结果 |
| Suggest a feature / 功能建议 | Search [existing issues](https://github.com/TNTcraftHIM/Piik/issues) first, then describe the use case / 先搜索已有讨论，再说明使用场景 |
| Contribute code / 参与开发 | [Run from source](./docs/README.md#run-from-source), then follow the workflow below / 从源码启动，按下文流程修改 |

Keep feedback specific and respectful. Explain a wording or design disagreement
with context and a suggested improvement. Review screenshots and diagnostics for
private content before attaching them. If you cannot run a check, say so in the
PR; maintainers can help identify what still needs verification.
讨论时请结合实际场景提出建议，尊重不同意见；分享截图或日志前移除隐私内容。
无法运行的检查请如实说明，便于维护者协助验证。

Review contributions by their practical value, evidence and fit with the product,
not their line count. A small fix that identifies and resolves a real defect is
valuable. Duplicate work already independently resolved, personal preferences or
low-value changes may be declined; merging is not an attribution mechanism.
Retain authorship for accepted contributions and credit substantive discoveries
accurately, without attributing independently written code to a PR author.
Before merging an external contribution, obtain the project owner's explicit
approval of the specific PR and accepted changes. This also applies when
extracting or cherry-picking its code into a maintainer PR. General permission
to investigate, fix issues or release does not authorize accepting external
contributions; review and verification may proceed before approval.
Keep contributor patches limited to their necessary changes. Integrate accepted
external contributions through their own focused PRs, preserving their authors
separately from a larger maintainer phase. A focused PR may land on `main`
without releasing a product version; use the
[publication hold](./docs/operations/github.md#enable-automatic-publication-once)
before a non-publishing merge. A co-author trailer credits a whole commit, not
selected lines; do not use a phase-wide squash to attribute unrelated maintainer work.
Check authorship on the final default-branch commit, not only on patch commits
that a later squash may discard. Use Git authorship for accepted contributions;
do not maintain a separate thanks list or manufacture empty credit commits.
评审看实际价值、证据和产品定位，不看代码行数。发现并解决真实问题的小修复同样值得接纳；
已经独立解决的重复工作、个人偏好或收益很低的改动可以不合并，不为增加贡献者名单而合并。
保留已接纳贡献的作者信息，如实说明有价值的问题发现；独立编写的代码不应冒记为他人共同编写。
合并外部贡献前，必须得到项目所有者对具体 PR 和接纳范围的明确同意；抽取或 cherry-pick
到维护者自己的 PR 也适用。检查、修复问题或发版的总体授权不等于接纳外部贡献；评审和验证可以先做。
接纳的外部贡献单独以小范围 PR 合入，保留作者身份，不混入维护者的大批改动。
合入 main 不要求立即发版；暂不发布时，合并前先暂停自动发布。共同署名作用于整个提交，不能按行分配；
验收署名以最终进入默认分支的提交为准，不另设鸣谢名单或空提交补贡献计数。

## Lean Workflow

This is the default for an ordinary scoped implementation or bug fix.

1. Start a new phase from clean, current canonical `main`; continue scoped work in that phase's existing worktree. Preserve unrelated user work.
2. Inspect the affected code, current owner, and reachable evidence. Use the
   repository's existing tools, commands and workflow; introduce another only
   when the requested result needs it. Research primary sources when the issue
   is non-trivial or component behavior is uncertain.
3. Make the smallest coherent change under the repo-tracked [`ponytail` skill](./.agents/skills/ponytail/SKILL.md).
4. Run the focused tests or checks that exercise the changed behavior, inspect the pending diff, stage requested files, and report the result and evidence.

Do not automatically create a truth checkpoint, edit status/memory, run `npm run check`, request independent reviews, open or merge a pull request, deploy, or clean branches/worktrees for every small change. Do not record ordinary UI details, self-evident implementation, one-off fixes, routine test output, or completed history in long-lived truth documents.

## Full Integration And Release Workflow

Use this path only when the owner explicitly requests it or when closing a major phase or changing a public contract, route/security model, infrastructure, persistent/irreversible state, or release boundary.

`main` is intentionally low-frequency. It is not a staging branch: all
intermediate implementation, experiments, evidence collection, release notes,
and cleanup stay in branches/worktrees. One complete, user-accepted phase lands
through one squash PR after its related checks and acceptance are finished;
leave `main` alone until the next material phase. Accepted external contributions
and user-authorized P0/P1 emergencies use separate focused PRs. Each must contain
one complete, reviewed change; a contribution merge does not authorize publication.

1. Create one short-lived branch/worktree from exact canonical `main`, following the [branch naming convention](#commit-pr-and-branch-names).
2. Update only the single durable owner for changed semantics and any materially changed current snapshot. If semantics remain disputed, record a hold and stop dependent work.
3. Implement and run repository hygiene, `npm run check`, the relevant browser/network gates, and review in proportion to the whole acceptance boundary.
4. Keep accepted truth checkpoints and dependent candidates on branches until the phase is complete. Rebase or rebuild a retained candidate from exact `main` only when starting a new phase, preserving main's owning truth on conflicts and transplanting only approved scoped code, tests, and new facts.
5. Open one pull request for the complete phase, resolve required review/checks, meet the [release approval boundary](./docs/standards/versioning.md#automatic-publication) before a publishing merge, squash-merge it once, deploy that merged revision when authorized, perform scoped postflight, then audit references and reparse safety before cleanup.

One coherent phase should leave one meaningful squash commit on `main`. Include
its source, tests, owned semantic documentation, and materially changed status
snapshot in that boundary. Do not open a follow-up pull request whose only
purpose is to copy the deployed revision, asset name, or artifact hashes into
the repository. Exact deployment identity belongs to the immutable release
descriptor, runtime `REVISION`, and deployment record. Preserve separate commits
only when they carry independently useful history.

Update `main` through PRs only; branch checkpoints and generated release metadata
do not bypass that boundary. Never force-push shared branches or rewrite shared
history without explicit approval.

For deployment work, a routine application-only release verifies a new immutable artifact, switches to it atomically, and guarantees the pre-cutover application release only through bounded health and postflight checks; it has no retention contract afterward and is not a maintained backup. Define recovery only for the infrastructure, configuration, secrets, persistent state, or irreversible surfaces the task actually touches, before changing them.

Use the [version/compatibility policy](./docs/standards/versioning.md) to classify
release changes. An incompatible signaling cutover forces old pages to reload
and ends Browser capture; follow the public compatibility promise and include
that interruption in the accepted cutover. Compatible UI/internal work does not
require a wire bump.

Clean up worktrees and branches only after semantic review and integration are complete and the normal merged-head, open-reference, clean-tree, and non-following link checks pass. Never merge an old branch wholesale after a newer truth checkpoint.

For owner-managed manual deletion, collect permitted retired artifacts in
`Desktop/Piik-cleanup` with their original paths. Keep worktrees under Git's cleanup
workflow. Targets of a policy-rejected cleanup stay in place and go in that path
index; do not substitute a move for the rejected deletion.

## Research Standard

The [engineering reference](./docs/standards/engineering.md) owns module and
interface discipline, including the post-change ablation pass.

Follow the [naming convention](./docs/standards/naming.md) for product copy,
commands, packages and code ownership. Keep display names separate from stable
protocol identifiers; use normal language-specific identifier conventions.

- Prefer specifications, official product documentation, primary source code, maintainers' design notes, and original papers.
- Use current community issues and operational reports to identify real compatibility failures, but label anecdotal evidence as such.
- Include a date and direct URLs. Separate verified facts, measurements, assumptions, and recommendations.
- Review licenses before copying implementation code. A useful reference is not automatically a compatible dependency.
- Piik-owned code is [MIT-licensed](./LICENSE); third-party components retain
  their own licenses and notices. GPL/AGPL implementation sources remain
  study-only unless a separate distribution decision accepts their obligations.

## Verification Entrypoints

Every retained test must be collected by a documented verification entry point.
Confirm runner inclusion when adding or moving a test; a file's presence alone
does not establish coverage.

- `npm run check` owns deterministic Web type-check, unit, and build acceptance.
- `npm run check:go` owns Go formatting, unit tests, vet, Windows/Linux
  builds, Darwin builds on macOS, and the current platform's capture compile/probe.
  The server core is Go, so its acceptance runs here. It builds the Web UI first when
  that output is missing, because both binaries embed it. CI invokes these same
  package commands rather than rebuilding their steps in YAML.
- `npm run check:go-race` checks port mapping, media forwarding, media-edge and native-control
  ownership, loopback delivery, service storage shutdown and scoped NAT dependencies with Go's race detector. It
  requires a supported cgo toolchain; CI runs it on Linux.
- `npm run check:go-vuln` checks the App and Server entry points and their
  dependencies against the Go vulnerability database. CI uses the Go version
  declared in `go.mod`; update that owner for required toolchain security fixes.
- `npm run check:native` runs only the current platform's capture compile/probe
  and deterministic native regressions. The Linux App packaging job includes
  its headless GStreamer output-profile and retirement test; this does not
  establish physical screen/audio capture on that runner.
  The macOS frame self-test additionally needs an available hardware H.264
  encoder. A runner without one reports that check as skipped and still checks
  compilation, capability/source responses and the packaged App's startup.
- `npm run check:container -- <local-image> <full-SHA>` checks the Compose recipe
  against a packaged native Linux image (amd64 or arm64): embedded Web, P2P/STUN, optional SFU
  startup, room persistence across recreation, diagnostics and clean shutdown.
  It requires Docker Compose v2 and available recipe ports on an isolated runner;
  its temporary project and volumes are removed after the check.
- `gate:*` commands are explicit physical or network acceptance. They must use
  isolated profiles, bounded deadlines, shared cleanup helpers, and a structured
  result. A manual diagnostic may locate a failure, but is not retained as pass
  evidence. Existing `PIIK_CLIENT_*` gate environment names retain their current
  contract; renaming the tools does not change those overrides.
- `gate:room-voice` exercises normal Host/Viewer pages against a local production
  server with real fake-device capture. Set `PIIK_ROOM_VOICE_GATE=true`,
  `CHROME_PATH` and `PIIK_SERVER_EXE`; repeat with `PIIK_ROOM_VOICE_SFU=true`
  for embedded SFU. Requires `agent-browser` (or `AGENT_BROWSER_PATH`). Reports
  and screenshots stay under ignored `build/voice-integration`.
- `gate:network-lab` runs the opt-in [controlled network laboratory](./docs/research/network-lab.md).
  It requires a disposable Linux runner with namespace administration. Its own
  routers contain all firewall and traffic-shaping changes; do not run it on a
  production service or treat its model results as a public success rate.
- `gate:media-lifecycle` reuses that laboratory's real Browser/App endpoints on
  loopback for restart, replacement and P2P/SFU continuity. It needs Chrome and
  current App/Server binaries, without namespace or firewall changes. Synthetic
  capture keeps it separate from physical-device and real-NAT acceptance.
- On Windows, execute App/Server and Go test binaries only from stable
  project build paths. Go's temporary compiler/cache files are not firewall
  identities; do not run network tests with a changing temporary executable
  path. Keep browser profiles isolated and consider the active firewall when
  diagnosing connection failures rather than changing global firewall rules.
- CI, versioning and release automation belong to complete, accepted squash
  merges into `main`; ordinary branch pushes stay quiet. PRs run only the
  lightweight public release-note check before merge. The
  [versioning policy](./docs/standards/versioning.md) owns version selection,
  publication and activation state. Package the merged SHA without writing
  version-record commits back to `main`.

## Commit, PR And Branch Names

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):
`type(scope): outcome`. Scope is optional. Use `feat` for new behavior, `fix`
for repairs, or `docs`, `refactor`, `test`, `build`, `ci`, and `chore` for their
named purpose. Keep the outcome short and concrete; English is the default,
and a Chinese explanation may follow in the body.

The PR title names the complete phase and becomes its single squash commit on
`main`, for example `fix(app): restore sharing after a source change`. Working
commits should follow the same form where useful; no history rewrite is needed
just to rename commits that will be squashed. Add `!` before the colon for a
breaking change, such as `feat(protocol)!: replace the join handshake`, and
explain its effect in the body. The final squash title and body supply release
intent; the [versioning policy](./docs/standards/versioning.md) owns version
selection and publication behavior.

Name branches `<type>/<short-kebab-case-description>`, using the same types;
reserve `spike/` for experiments. No issue number is required. 中文说明：PR 标题
与最终 squash 提交使用上述格式；分支用英文短名，破坏性变更标记 `!` 并说明影响。

## Pull Request Scope

A pull request should explain the problem, the chosen design, verification performed, user-visible or operational effects, and remaining risks.

Before a product-changing integration PR is accepted, fill its exact `## Release notes` section
with concise public copy in English followed by Chinese: user-visible changes,
fixes and required upgrade actions. Use `###` for subsections. Review this text as product
copy; it is published automatically from the squash commit, without PR discussion
or verification logs. The [release-note policy](./docs/standards/versioning.md#release-notes)
owns the optional editorial headline, aggregation and preview. Review the
generated whole release and its website excerpt together before publication;
keep at most one bilingual theme and make this update's actual changes easy to find.
Do not add a changelog file or release-note archive.
Standalone website, documentation and maintenance phases do not need product
release notes; their public description stays in the PR.

Durable semantic or current-snapshot changes must update their single owner in the same integration boundary. Ordinary implementation and bug fixes may be complete with code plus focused evidence.

## Local Hooks

Install the tracked Git hooks once per clone:

```sh
sh scripts/install-hooks.sh
```

On native PowerShell, this equivalent is available:

```powershell
./scripts/install-hooks.ps1
```

The pre-commit hook runs the POSIX repository hygiene check. The PowerShell entry implements the same checks for native Windows use, and CI runs the POSIX entry. Both read the tracked path manifest in `scripts/required-project-paths.txt`; changes to checker behavior must update and verify both in the same pull request.
