# Agent 上下文与仓库治理调研

- 调研日期：2026-08-18
- 范围：Codex、Claude Code、Hermes Agent 与 GitHub Flow 的官方资料
- 目的：让长 session 和多设备开发可恢复，同时限制常驻上下文膨胀与陈旧事实污染

## 官方资料中的共同原则

### Codex

Codex 从 Git 根目录向当前工作目录发现 `AGENTS.md`，越接近当前目录的文件优先级越高；默认合并上限为 32 KiB。适合把仓库级不变量放在根文件，把未来模块特有规则放在相邻目录，而不是把所有细节集中到一个无限增长的说明中。

来源：

- [Codex AGENTS.md 官方说明](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Codex 项目配置官方说明](https://learn.chatgpt.com/docs/config-file/config-basic)

### Claude Code

Claude Code 官方建议项目指令具体、简洁、结构化，单个 `CLAUDE.md` 目标控制在 200 行以内，并定期清理冲突或过时指令。官方还区分“上下文中的建议”和“确定执行的 hook”：必须在固定时机运行的检查应写成 hook。根 `CLAUDE.md` 会在压缩后重新注入；大型读取可以交给独立 subagent，主上下文只接收结论。

Claude Code 原生读取 `CLAUDE.md`，官方建议已有 `AGENTS.md` 的仓库通过 `@AGENTS.md` 导入，避免复制两份规则。本仓库因此保留一个极小的根 `CLAUDE.md` 作为兼容入口。

来源：

- [Claude Code 项目记忆与 CLAUDE.md](https://code.claude.com/docs/en/memory)
- [Claude Code 上下文窗口与压缩](https://code.claude.com/docs/en/context-window)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks-guide)

### Hermes Agent

Hermes Agent 的内置 memory 采用硬字符上限，并明确要求容量接近上限时先合并或删除旧条目。官方把“始终需要的关键事实”与“需要时再搜索的历史 session”分开；还明确不应保存原始数据、临时上下文、容易重新发现的信息或已经存在于项目指令中的重复内容。

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
- `project-memory.md` 是最多 12 KB 的当前事实快照；`status.md` 是当前阶段快照；两者都更新和清理，不追加对话历史。
- 需求、ADR、调研、代码、测试和 Git/PR 各自承担不同类型的事实，避免同一信息在多个常驻文件里漂移。
- 非平凡变更先做一手资料调研，耐久结论才进入 `docs/research/`；大量原始资料不进入常驻 memory。
- 快速确定的约束由 tracked Git hook 和 CI 执行，判断型检查留给测试和评审。
- 每个重大 PR 都包含一次上下文卫生检查：更新新事实、删除旧事实、确认没有未跟踪项目文件。
