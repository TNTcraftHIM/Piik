# 项目维护与上下文治理

## 目标

仓库是跨 session、设备和 agent 的持久事实源。会影响后续工作的结论必须先进入其权威文档；聊天、agent 摘要、旧分支和临时计划都不能替代仓库真相。

常驻上下文只保留每次工作都需要的边界和导航。细节按需读取，完成历史交给 Git。任务范围、最小正确结果和 current-result 交付遵循 `AGENTS.md` 摘要并完整读取仓库内的 [`stop-that-shit` skill](../.agents/skills/stop-that-shit/SKILL.md)；本文件只维护仓库特有的事实治理规则。

## 事实分层

| 内容 | 权威归属 | 维护方式 |
| --- | --- | --- |
| 每次都必须遵守的硬约束和导航 | `AGENTS.md` | 保持短、单义、稳定；不复制流程手册或临时状态 |
| 分支、研究、验证、PR、合并和清理流程 | `CONTRIBUTING.md` | 维护可执行的日常流程 |
| 产品总览和领域导航 | `docs/project-memory.md` | 只保留每次 substantial task 都需要的摘要与链接 |
| 当前生产、里程碑、阻塞项和明细索引 | `docs/status.md` | 只保留 current/index；接近 120 行或 12 KB 时提示园艺审查 |
| 当前未决、已授权或待用户决策的工作 | `docs/todo.md` | 不是完成记录；不把 checkbox、实验或 agent 建议自动升级为 TODO |
| 当前产品合同 | `docs/product/` | 每个领域一个 owner；只写行为、边界和非显然不变量 |
| 架构取舍 | `docs/adr/` | 明确状态；新决定替代冲突旧决定 |
| 可复核证据和研究结论 | `docs/research/` | 标日期、来源、推断、适用边界和许可证 |
| 当前验证与部署边界 | `docs/verification-status.md`、`docs/deployment.md`、`docs/operations/`、`docs/reference/` | 按需读取，不保存发布流水账 |
| 已完成工作的时间线 | commit、PR、issue | 不复制进常驻 memory 或 status |

每个事实只有一个 owner。顶层文件提供链接和当前结论，不复制深层正文；`docs/README.md` 维护完整文档索引。

## 顶级指令卫生

[官方调研](./research/agent-context-governance.md)的共同结论是：顶层指令应是短而稳定的地图，流程和专业细节按需加载，并定期删除冲突或陈旧规则。因此本仓库的 `AGENTS.md` 保持在 100 行内，而不是把公开上限当作填充目标。模块特有规则只有在对应代码存在且每次读取确有必要时，才放到最近目录的 `AGENTS.md`；流程说明进入 `CONTRIBUTING.md`，当前工作进入 `docs/todo.md`，证据与理由进入其 owner。

## 真相更新顺序

1. 按 [`stop-that-shit`](../.agents/skills/stop-that-shit/SKILL.md) 的 authority 和 scope 规则，对照完整产品模型、当前代码、测试和证据确定目标；语义未定时只冻结依赖项。
2. 就地更新受影响的 product、ADR 或 research owner；仅在快照确实变化时同步 memory/status，未决执行项进入 TODO。
3. 检查各 current owner 一致并形成 Git-tracked truth checkpoint，再开始依赖该结论的实现或派发。

语义仍未决定时，在 TODO 记录 hold，只冻结依赖项。具体 Git、worktree、checkpoint 和 integration 流程由 `CONTRIBUTING.md` 拥有。

## 机制减负审查

机制减负遵循 [`stop-that-shit`](../.agents/skills/stop-that-shit/SKILL.md) 的 scope 和 smallest-correct-result 规则。本仓库的审查先只读清点机制服务的用户行为，量化移除后的真实退让，并与代码、配置、迁移、测试、运行时状态、部署和故障面的整体成本比较。文档也是需要同步和审查的机制：长期真相只保留产品合同、非显然不变量、算法/模型、关键取舍和外部证据，普通 UI 与实现细节由代码、测试和 PR 持有。若 owner 接受有界退让，先更新产品合同再删除失去必要性的完整表面；否则保留合同并寻找更小实现。审查不以行数为目标，也不授权无边界重构。

TURN 的减负证据由 [ADR-0005](./adr/0005-automatic-hybrid-media-routing.md) 和相关 transport research 持有；轻量/SQLite 房间取舍由 [ADR-0002](./adr/0002-memory-resident-protected-rooms.md) 持有。这些案例只证明应按当前消费者重审完整成本，不能被推广为永远删除或永远保留某类机制的规则。

## 检查点与恢复

在需求或优先级被接受、设计或研究结论改变、实质阶段切换、分支/PR/agent 交接、可能 compaction 或长暂停前更新事实 owner。不要为每个函数、工具调用或未形成结论的探索建立检查点。

检查点按 [`stop-that-shit`](../.agents/skills/stop-that-shit/SKILL.md) 的 current-result 规则，只保存以后仍需要的结论、当前状态、下一步和真实阻塞；不保存原始对话或工具输出、完整日志、临时路径、可廉价重查的事实和过程性 TODO 流水账。

恢复上下文时依次读取 `AGENTS.md`、project memory、status、TODO、相关 product/ADR/research，然后检查当前分支、`git status`、近期 commit 和 PR。摘要与仓库冲突时，以当前代码、测试和权威文档为准。

## 清理规则

- `project-memory.md` 和 `status.md` 接近预算时，先删除可从代码或 Git 恢复的完成/失效内容，再把仍需保留的细节迁到现有 owner；不要反复微压缩句子。
- `todo.md` 只保留真实未完工作、明确 hold 和待用户决策，不保留完成清单或一次性审计过程。
- `verification-status.md` 只保留仍影响验收的跨模块证据；成熟结论迁回 product、ADR、research 或 operations，过期结果删除。
- Product 合同不追加确认流水；研究失效时更新正文及最后验证日期；只有仍有解释价值的历史取舍进入 ADR。
- 每个重要 PR 检查 current 文档是否互相矛盾、链接是否有效、memory/status/TODO 是否仍代表现在。

## 验证与自动化

- 迭代中运行覆盖当前改动的最小定向检查；完整套件、真实浏览器矩阵、网络整形、跨设备、长时稳定性和部署检查在相关候选的验收边界批量运行。
- 文档改动默认运行本地 Markdown 链接、whitespace、diff 和 repository-hygiene 检查；不因无关文档变化重跑媒体基准。
- 断链、缺失必需 owner 和格式损坏是 hard failure。每次注入的 `AGENTS.md`、repo STS skill 与只负责导入的 `CLAUDE.md` 也使用 hard context budget，避免规则稀释。Product、ADR、research、operations 等按需文档的行数/字节阈值只是 warning：它提示检查是否应拆分二级 owner、删除历史或移出过程信息，不要求为通过门禁压缩合理正文，也不是交付质量指标。
- 昂贵证据记录 commit、环境、结果和适用边界。只有相关路径、协议、配置、依赖、环境或门槛改变，或旧证据失败/含糊时才重跑。
- `.githooks/pre-commit`、`scripts/check-project-state.sh` 和 PowerShell 等价入口共享 `scripts/required-project-paths.txt`。Hook 只做快速、确定、可复现的检查；工程判断留给评审和测试。
