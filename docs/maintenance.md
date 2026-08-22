# 项目维护与上下文治理

## 目标

仓库本身是跨 session、跨设备、跨 agent 的唯一持久事实源。聊天记录可以很长，但任何会影响后续工作的决定都不能只存在于聊天中；同时，常驻上下文不能退化成聊天流水账。

所有维护遵守奥卡姆剃刀：选择能完整满足已验证需求的最简单方案。没有当前消费者、实测瓶颈或重复问题时，不增加抽象、服务、拓扑、hook 或“以后可能用到”的框架。

## 事实分层

| 内容 | 文件 | 维护方式 |
| --- | --- | --- |
| 每次都必须遵守的规则 | `AGENTS.md` | 保持短、明确、无冲突，最多 200 行 |
| 当前产品事实与长期决定 | `docs/project-memory.md` | 就地更新，最多 200 行且不超过 16 KB |
| 当前生产、活跃里程碑、阻塞项及明细索引 | `docs/status.md` | 只保留 current/index，最多 120 行且不超过 12 KB |
| 跨模块的当前验证证据与待验证边界 | `docs/verification-status.md` | 按需读取、就地更新；不是完成记录或发布流水账 |
| 当前可验收需求 | `docs/需求理解.md` | 修改现行规范；变更历史交给 Git |
| 架构取舍与原因 | `docs/adr/` | 状态化管理；新决定 supersede 旧 ADR |
| 可复核的证据、保留候选与验收门槛 | `docs/research/` | 标注日期、来源和适用边界，过时结论要更新或标记 |
| 已完成工作的时间线 | commit、PR、issue | 不复制进常驻 memory |

每个事实只设一个权威归属，顶层文件只索引，不复制深层正文。一次检查点的最小真相集只包含后续执行无法安全重建的内容：已接受且仍生效的要求/约束、当前实现与证据边界、下一项可执行工作、真实阻塞或未决项，以及需要继续工作的分支/PR。能从代码、测试、Git 或权威资料廉价恢复的细节不进入常驻快照。

## 长 Session 检查点

在以下时机更新仓库快照：

- 用户确认或改变产品范围、优先级、约束或工作习惯后，在依赖该结论的设计或实现继续前；
- 一个重要设计、调研结论或验收门槛被接受、推翻或被实测结果修正后；
- 从调研、设计、实现、验证中的一个实质阶段进入下一阶段时；
- 切换分支、提交/更新 PR、agent 交接或任务交接前；
- 长任务可能自动压缩、即将暂停或离开当前 session 前。

检查点应立即修改事实的权威归属文件；只有当前全局快照确实改变时才同步修改 `project-memory.md` 或 `status.md`。不要等到 session 末尾才补写，也不要为每个文件、函数、工具调用或未形成结论的探索建立检查点。

讨论、纠正、示例、review 建议、实验结论、checkbox 或 agent 推导都只是输入，不能直接触发实现。先复述目标和源头理由，放回完整产品模型检查矛盾与不必要复杂度，再更新所有受影响的 owning requirement/design/ADR/research 以及确实变化的 memory/status/global rule，并形成 Git-tracked checkpoint。只有 nonvolatile truth 自洽后才能开始实现或派发实现；语义未决时先建立 truth hold，只冻结依赖项。

集成必须先让 accepted truth checkpoint 进入 main，再逐个把保留候选基于该 main 做一次 rebase 或重建。冲突以 main 的 owning truth 为底，只移植已批准的 scoped code/tests/new facts；旧分支中的 `AGENTS.md`、requirements、ADR、memory、status、deployment snapshot 不得覆盖新真相。语义裁决和集成完成后才进入 worktree/branch 清理，并继续执行 PR 等价、开放引用和 link/reparse 安全检查。

审计或集成阶段结束后，先显式保全仍需保留的用户修改，再让 canonical repository root 回到 clean、最新的 `main`；辅助 worktree 不得长期占用 `main`。后续每个实现分支和并行 worktree 都必须从该 canonical `main` 的精确提交创建，不能从旧候选、旧快照或另一个辅助 worktree 继续开枝散叶。只有这一步完成后，才恢复功能实现并行。

当真相审计与功能设计同时存在时，严格按以下依赖顺序推进：先整理 TODO 来源和全部 current truth owner，再形成文档归档及 worktree/branch/folder 处置排期；随后合入审计护栏、恢复 canonical `main` 并只执行已批准的工作区清理；然后才从该 main 做整体设计建模并把它保持为 held proposal。并行化只能加速当前阶段，不能绕过前置真相或提前执行功能实现、候选合并或部署。

完成 canonical root/workspace 整理和整体设计 held proposal 后，必须先向用户报告唯一 `main` SHA、根目录状态、保留/清理项、设计模型和拟恢复 TODO，等待明确核对。核对前不得接受最终争议语义，也不得为“剩余 TODO”新建或恢复实现 worktree；核对后先更新 accepted owning truth，所有高置信并行 worktree 再只从该 exact canonical `main` 创建。

检查点只保存以后仍需要的结论、当前状态、下一步和阻塞项。不要保存原始对话、完整日志、工具输出、临时文件路径、重复的代码结构、可随时重新搜索的常识、过程性 TODO 流水账或已经在其他规范中存在的内容。

恢复上下文时按以下顺序读取：`AGENTS.md`、`docs/project-memory.md`、`docs/status.md`、相关需求/ADR/调研，然后检查当前分支、`git status`、最近 commit 和 PR 状态。任何摘要与仓库冲突时，以当前代码、测试和正式文档为准。

## 清理规则

- 新事实与旧事实冲突时，在同一变更中替换或删除旧内容。
- `project-memory.md` 达到约 80% 上限时，先合并同类条目并删除可从代码或 Git 重新发现的内容。
- `status.md` 接近上限时，删除已完成或已失效且可由 Git 恢复的内容；仍需保留的细节迁到现有权威文档。只有跨模块的当前验证台账没有自然归属时才进入 `verification-status.md`，主状态留一句结论和链接。不要为了通过门禁反复微压缩句子。
- `verification-status.md` 只保留仍影响当前验收的证据和边界；专业结论成熟后迁回对应 requirement、ADR、research 或 deployment 文档，过期结果直接删除。
- 需求文档保持单一现行版本，不在末尾无限追加确认记录。
- 调研结论失效时更新正文并保留“最后验证日期”；只有仍有历史解释价值的决策才进入 ADR。
- 已完成的临时计划从 `status.md` 删除，由合并后的 PR 和 commit 保存历史。
- 每个重要 PR 都检查文档是否互相矛盾、链接是否仍有效、memory/status 是否仍代表当前事实。

## 验证节奏

- 迭代中运行能覆盖当前改动的最小定向检查；同一未变化路径已经通过的昂贵检查不因相邻小改动自动失效。
- 完整测试套件、真实浏览器矩阵、长时稳定性、网络整形、跨设备和部署验证按一个完整候选或验收阶段批量运行。只有相关媒体路径、协议、配置、依赖、环境或验收门槛改变，或者上次结果失败/含糊时才重跑对应证据。
- 文档改动默认只运行 Markdown/链接/whitespace/diff 检查；不为与运行时代码无关的改动重跑 npm 全套或媒体基准。
- 在 `status.md`、调研或 ADR 中记录昂贵验证对应的 commit、环境、结果和适用边界，PR 可以引用该记录，使后续工作能判断证据是否仍有效，而不是机械重跑。
- 发布、安全边界、数据库迁移和部署切换仍按其风险执行必要的最终门禁；“批量验证”不是跳过会被当前变更影响的检查。
- `gate:*` 只承载当前验收确实需要的正确性、安全、协议或资源上限；`probe:*` 是可选研究入口，不进入 Web 验收。localhost synthetic loopback 可记录诊断耗时，但不能用该耗时判定产品性能、标定阈值或阻断可逆标准能力。

## 阶段验收后的有界架构收敛

> `AUDIT-HOLD / HISTORICAL`：本节是 2026-08-19 的延期审查提案，不是当前授权 TODO、当前里程碑或架构不变量。其旧文件规模、owner、百分比假设、`SFU roots`/exceptional-edge/Host-two 表述只能作为 provenance 输入；必须等 [TODO audit hold](./todo-audit-hold.md) 完成、canonical root 回到最新 `main`，并由用户重新接受范围后才可重建或删除本节。

这是一项明确延期的收官任务。只有当前主要功能基本完成、相关主线变更合并且阶段验收完成后才可启动；它不阻断或抢占当前的质量证据、自动路由 exact-room canary、native sender 或部署工作。启动时从届时最新 `main` 建立一个短期 `refactor/` 或 `chore/` 分支。当前只记录审查契约，不实施重构。

2026-08-19 的一次只读盘点估算约有 14,153 行产品源码和 31,094 行第一方文本，并标出以下高集中度 owner：

- `src/server/hybrid-media-router.ts`：约 1,605 行；
- `src/client/pages/HostPage.tsx`：约 1,455 行；
- `src/server/signaling.ts`：约 1,057 行；
- `scripts/peer-assisted-benchmark.ts`：约 2,271 行，当前入口是仅验证解码、拓扑与两边上限的 `gate:peer-topology-loopback`。

这些总量、分类口径和“产品源码可能净减少 7%-14%”都只是当日待重测的审查假设，不是删除指标、承诺区间或 LOC KPI。文件长度也不单独证明职责错误。正式审查必须先重新读取 `AGENTS.md`、当前 memory/status、需求、相关研究及 [ADR-0004](adr/0004-peer-assisted-media-experiment.md)/[ADR-0005](adr/0005-automatic-hybrid-media-routing.md)，重新统计届时 `main`，明确计数口径，并按消费者和测试把代码分为：

1. 当前生产路径必需；
2. 自动 `direct/peer UDP -> SFU roots -> optional exceptional-edge TURN` 目标必需；
3. 有明确下一阶段消费者和退出条件的实验能力；
4. 已被替代、重复、无消费者或仅服务一次性定位的代码。

任何实现开始前，先输出基于证据的候选清单、行为与迁移风险，以及按 owner 说明依据的预计净减少范围；范围可以低于 7%、为零，或证明当前不值得改。评审该输出后再决定是否实施，不能用预设比例反推删除。

审查优先减少状态 owner、重复路径和认知负担：先删除已证明无消费者的代码，再合并重复逻辑，只在已有独立职责和消费者时提取窄模块。重点检查：

- `SignalingServer` 是否能只保留认证、WebSocket 分发与薄协调职责；
- `HybridMediaRouter` 的拓扑计划、SFU grant/lifecycle、intent drain 和广播是否形成可独立验证的自然边界；
- `HostPage`/`ViewerPage` 的纯媒体编排与展示状态能否适度分离，而不建立新的前端架构层；
- peer topology loopback 的一次性探针和重复 CDP 逻辑能否收缩，同时保留可重复的正确性边界；
- 测试 setup/fixtures 能否合并，同时完整保留竞态、鉴权和 host edge 上限覆盖。

不要为了缩短文件机械拆分，也不要引入通用框架、工厂、事件总线或更多状态机。Peer/SFU 代码不能因默认关闭就视为多余：若 canary 和 ADR 门槛支持该路线，则保留并整理；若路线被实测否决或明确替代，则删除失败路径，不长期保留无消费者的负担。

任何候选改动都必须保持以下行为不变：

- 用户无感的自动 `direct/peer UDP -> SFU roots -> optional exceptional-edge TURN` 梯级；
- 每条媒体边独立执行 ICE，普通 peer 默认不收到 TURN；启用兼容层时只有授权的异常 edge 可使用短期凭据；
- host 下游活跃媒体边不超过两个；
- 普通桌面或移动浏览器 Viewer 无需安装应用；
- break-before-make、安全授权、重连、回滚和陈旧消息隔离语义；
- 轻量实例可关闭 controller；旗舰部署以 `PEER_ASSISTED_MEDIA=true` 对所有正常房间启用，room `1` 仅是历史 smoke，已不再保留 exact-room allowlist 灰度边界。

实现期间只运行覆盖当前改动的窄测；完整候选形成后统一运行一次 full check。除非媒体行为或证据采集逻辑改变，不重跑昂贵浏览器/网络矩阵。实现 PR 必须原位同步 status、project memory 和相关 ADR，删除失效描述，不新增过程流水账文档。

## 在线调研规则

非平凡的设计、实现和 bug 修复先读仓库，再查当前的一手资料。优先级为规范/官方文档、官方源码与维护者说明、原始论文，然后才是高质量社区复现与运行经验。安全、网络协议、浏览器能力、依赖版本和云服务行为属于易变化信息，必须按当前日期重新验证。

调研输出应说明问题、来源日期、已证实事实、推断、候选方案、许可证、适用边界和最终采用理由。不要把搜索结果原样堆进常驻上下文。

## 自动化

- `.githooks/pre-commit` 和 CI 调用 `scripts/check-project-state.sh`；原生 Windows 可运行等价的 `scripts/check-project-state.ps1`。两份入口共享 `scripts/required-project-paths.txt`，检查 whitespace、清单内必需文件的 Git 跟踪状态和上下文文件上限。
- `.github/workflows/repository-hygiene.yml` 在 push/PR 上运行 tracked POSIX 入口。
- hook 只做快速、确定、可复现的检查；需要工程判断的内容留给评审和测试。
- 新脚本必须有明确当前用途、适用平台、失败信息和调用方。可选研究 probe 不要求进入 CI；没有现实使用者的 hook 或框架不进入仓库。
