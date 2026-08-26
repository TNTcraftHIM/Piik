# 项目维护与上下文治理

## 目标

仓库是跨 session、设备和 agent 的持久事实源。会影响后续工作的结论必须先进入其权威文档；聊天、agent 摘要、旧分支和临时计划都不能替代仓库真相。

常驻上下文只保留每次工作都需要的边界和导航。细节按需读取，完成历史交给 Git。任务范围、最小正确结果和 current-result 交付遵循 `AGENTS.md` 摘要并完整读取仓库内的 [`stop-that-shit` skill](../.agents/skills/stop-that-shit/SKILL.md)；本文件只维护仓库特有的事实治理规则。

## 事实分层

| 内容 | 权威归属 | 维护方式 |
| --- | --- | --- |
| 每次都必须遵守的硬约束和导航 | `AGENTS.md` | 保持短、单义、稳定；不复制流程手册或临时状态 |
| 分支、研究、验证、PR、合并和清理流程 | `CONTRIBUTING.md` | 维护可执行的日常流程 |
| 当前产品事实和长期决定 | `docs/project-memory.md` | 就地更新，最多 200 行且不超过 16 KB |
| 当前生产、里程碑、阻塞项和明细索引 | `docs/status.md` | 只保留 current/index，最多 120 行且不超过 12 KB |
| 当前未决、已授权或待用户决策的工作 | `docs/todo.md` | 不是完成记录；不把 checkbox、实验或 agent 建议自动升级为 TODO |
| 当前需求与设计 | `docs/需求理解.md`、`docs/方案设计.md` | 维护一个现行版本，变更历史交给 Git |
| 架构取舍 | `docs/adr/` | 明确状态；新决定替代冲突旧决定 |
| 可复核证据和研究结论 | `docs/research/` | 标日期、来源、推断、适用边界和许可证 |
| 当前验证与部署边界 | `docs/verification-status.md`、`docs/deployment.md` | 按需读取，不保存发布流水账 |
| 已完成工作的时间线 | commit、PR、issue | 不复制进常驻 memory 或 status |

每个事实只有一个 owner。顶层文件提供链接和当前结论，不复制深层正文；`docs/README.md` 维护完整文档索引。

## 顶级指令卫生

[官方调研](./research/agent-context-governance.md)的共同结论是：顶层指令应是短而稳定的地图，流程和专业细节按需加载，并定期删除冲突或陈旧规则。因此本仓库的 `AGENTS.md` 目标是约 50 行，而不是把任何公开上限当作填充目标。模块特有规则只有在对应代码存在且每次读取确有必要时，才放到最近目录的 `AGENTS.md`；流程说明进入 `CONTRIBUTING.md`，当前工作进入 `docs/todo.md`，证据与理由进入其 owner。

## 真相更新顺序

1. 按 [`stop-that-shit`](../.agents/skills/stop-that-shit/SKILL.md) 的 authority 和 scope 规则，对照完整产品模型、当前代码、测试和证据确定目标；语义未定时只冻结依赖项。
2. 就地更新受影响的 requirement、design、ADR 或 research owner；仅在快照确实变化时同步 memory/status，未决执行项进入 TODO。
3. 检查各 current owner 一致并形成 Git-tracked truth checkpoint，再开始依赖该结论的实现或派发。

语义仍未决定时，在 TODO 记录 hold，只冻结依赖项。接受的真相先进入 canonical `main`；保留候选再从该精确提交 rebase 或重建一次，只移植获批的 scoped code、tests 和 new facts。旧分支的 truth 文档不得覆盖当前 owner。具体 Git 和 worktree 操作遵循 `CONTRIBUTING.md`。

## 机制减负审查

机制减负遵循 [`stop-that-shit`](../.agents/skills/stop-that-shit/SKILL.md) 的 scope 和 smallest-correct-result 规则。本仓库的审查先只读清点机制服务的用户行为，量化移除后的真实退让，并与代码、配置、迁移、测试、运行时状态、部署和故障面的整体成本比较。文档也是需要同步和审查的机制：长期真相只保留产品合同、非显然不变量、算法/模型、关键取舍和外部证据，普通 UI 与实现细节由代码、测试和 PR 持有。若 owner 接受有界退让，先更新产品合同再删除失去必要性的完整表面；否则保留合同并寻找更小实现。审查不以行数为目标，也不授权无边界重构。

应用层 TURN 清理是 [ADR-0005](./adr/0005-automatic-hybrid-media-routing.md) 的机制减负实例；TURN 的完整成本证据由 [ICE/TURN 研究](./research/built-in-peer-ice-turn.md)维护。内存房间曾以有限恢复收益换取更小机制，但真实开发发布已证明旧邀请、撤销高水位和房间权威连续性构成一个内聚 SQLite 消费者，因此 [ADR-0002](./adr/0002-memory-resident-protected-rooms.md) 现在保留轻量与稳定两种模式。该变化说明减负结论必须随可达需求重审，而不是把一次删除推广为永不恢复该机制。

## 检查点与恢复

在需求或优先级被接受、设计或研究结论改变、实质阶段切换、分支/PR/agent 交接、可能 compaction 或长暂停前更新事实 owner。不要为每个函数、工具调用或未形成结论的探索建立检查点。

检查点按 [`stop-that-shit`](../.agents/skills/stop-that-shit/SKILL.md) 的 current-result 规则，只保存以后仍需要的结论、当前状态、下一步和真实阻塞；不保存原始对话或工具输出、完整日志、临时路径、可廉价重查的事实和过程性 TODO 流水账。

恢复上下文时依次读取 `AGENTS.md`、project memory、status、TODO、相关需求/设计/ADR/研究，然后检查当前分支、`git status`、近期 commit 和 PR。摘要与仓库冲突时，以当前代码、测试和权威文档为准。

## 清理规则

- `project-memory.md` 和 `status.md` 接近预算时，先删除可从代码或 Git 恢复的完成/失效内容，再把仍需保留的细节迁到现有 owner；不要反复微压缩句子。
- `todo.md` 只保留真实未完工作、明确 hold 和待用户决策，不保留完成清单或一次性审计过程。
- `verification-status.md` 只保留仍影响验收的跨模块证据；成熟结论迁回 requirement、ADR、research 或 deployment，过期结果删除。
- 需求和设计不在末尾追加确认流水；研究失效时更新正文及最后验证日期；只有仍有解释价值的历史取舍进入 ADR。
- 每个重要 PR 检查 current 文档是否互相矛盾、链接是否有效、memory/status/TODO 是否仍代表现在。

## 验证与自动化

- 迭代中运行覆盖当前改动的最小定向检查；完整套件、真实浏览器矩阵、网络整形、跨设备、长时稳定性和部署检查在相关候选的验收边界批量运行。
- 文档改动默认运行 Markdown、链接、whitespace、diff 和 repository-hygiene 检查；不因无关文档变化重跑媒体基准。
- 昂贵证据记录 commit、环境、结果和适用边界。只有相关路径、协议、配置、依赖、环境或门槛改变，或旧证据失败/含糊时才重跑。
- `.githooks/pre-commit`、`scripts/check-project-state.sh` 和 PowerShell 等价入口共享 `scripts/required-project-paths.txt`。Hook 只做快速、确定、可复现的检查；工程判断留给评审和测试。
