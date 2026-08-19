# Agent 上下文与仓库治理调研

- 调研日期：2026-08-18
- 最后复核：2026-08-19
- 范围：Codex、Claude Code、Hermes Agent 与 GitHub Flow 的官方资料
- 目的：让长 session 和多设备开发可恢复，同时限制常驻上下文膨胀与陈旧事实污染

## 官方资料中的共同原则

### Codex

Codex 从 Git 根目录向当前工作目录发现 `AGENTS.md`，越接近当前目录的文件优先级越高；默认合并上限为 32 KiB。官方还要求规则保持简洁，并建议长任务在重大里程碑后压缩，而不是每轮压缩。因此仓库级不变量应放在根文件，具体流程按需放进维护文档或相邻目录，且同一规则只表达一次。

来源：

- [Codex AGENTS.md 官方说明](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Codex 项目配置官方说明](https://learn.chatgpt.com/docs/config-file/config-basic)
- [OpenAI 模型指南：精简提示与里程碑压缩](https://developers.openai.com/api/docs/guides/latest-model)

### Claude Code

Claude Code 官方建议项目指令具体、简洁、结构化，单个 `CLAUDE.md` 目标控制在 200 行以内，并定期清理冲突或过时指令。根 `CLAUDE.md` 和 auto memory 会在压缩后从磁盘重新注入，而仅存在于对话的指令可能丢失；`MEMORY.md` 只把前 200 行或 25 KB 作为常驻索引，并要求临近上限时合并或删除陈旧内容。官方还区分“上下文中的建议”和“确定执行的 hook”：必须在固定时机运行的机器检查应写成 hook，大型读取可以交给独立 subagent，主上下文只接收结论。

Claude Code 原生读取 `CLAUDE.md`，官方建议已有 `AGENTS.md` 的仓库通过 `@AGENTS.md` 导入，避免复制两份规则。本仓库因此保留一个极小的根 `CLAUDE.md` 作为兼容入口。

来源：

- [Claude Code 项目记忆与 CLAUDE.md](https://code.claude.com/docs/en/memory)
- [Claude Code 上下文窗口与压缩](https://code.claude.com/docs/en/context-window)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks-guide)

### Hermes Agent

Hermes Agent 的内置 memory 采用硬字符上限，并明确要求容量接近上限时先合并或删除旧条目。官方把“始终需要的关键事实”与“需要时再搜索的历史 session”分开；还明确不应保存原始数据、临时上下文、容易重新发现的信息或已经存在于项目指令中的重复内容。其 memory 是 session 启动时的冻结快照，进一步说明跨设备、跨 agent 的项目事实应进入 Git 跟踪的项目文件，而不是机器本地 memory。

Hermes Agent 的开发指南强调保持核心窄小、优先扩展已有接口、避免没有当前使用者的 speculative hook，并要求真实路径验证而不只依赖 mock。这些原则适合约束本项目未来的 agent、hook 和脚本增长。

来源：

- [Hermes Agent 持久记忆](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md)
- [Hermes Agent 开发指南](https://github.com/NousResearch/hermes-agent/blob/main/AGENTS.md)

### GitHub Flow

GitHub 官方流程是短分支、隔离的完整 commit、push 远端、PR 评审与检查、merge 后删除分支。远端 push 同时提供跨设备备份；PR 和 commit 历史比在 memory 中复制时间线更适合保存完成记录。

来源：[GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow)

## 本仓库采用的设计

- 根 `AGENTS.md` 最多 200 行，只放跨任务不变量；`.codex/config.toml` 将指令发现预算固定为 32 KiB。
- `CLAUDE.md` 只导入 `AGENTS.md`，不维护第二份规则。
- `project-memory.md` 是最多 12 KB 的当前事实快照；`status.md` 是当前阶段快照；两者只保留最小真相集并就地更新，不追加对话、过程 TODO 或完成时间线。
- 上下文按层归属：`AGENTS.md` 保存顶级约束与读取触发器；memory/status 保存当前最小快照；现行需求/设计和 ADR 保存已接受约束；research 保存证据、候选与门槛；Git/PR 保存时间线。顶层只索引深层事实，不复制正文。
- 已接受的需求、设计变化、调研结论、可执行 TODO、阻塞和状态必须在依赖工作继续前落到对应 Git 跟踪文件。阶段边界、分支/PR/agent 交接和压缩风险是自动检查点；恢复后先重读快照和 Git 状态。
- 非平凡变更先做一手资料调研，耐久结论才进入 `docs/research/`；大量原始资料不进入常驻 memory。
- 快速确定的约束由 tracked Git hook 和 CI 执行，判断型检查留给测试和评审。
- 每个重大 PR 都包含一次上下文卫生检查：更新新事实、删除旧事实、确认没有未跟踪项目文件。

上述“自动检查点”和分层归属是本仓库根据官方机制做出的工程约束，不是这些工具自动提供的跨工具同步能力。来源均于 2026-08-19 访问；Hermes Agent 来源为其官方仓库，Claude Code 与 Codex/OpenAI 来源为各自官方文档。
