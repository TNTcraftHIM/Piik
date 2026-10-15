---
name: stop-that-shit
description: >
  Keep Piik work proportionate and finish the requested result. Apply during
  implementation, debugging and review, especially when speculative defenses,
  repeated testing, compatibility scaffolding, research loops or cautious
  narration displace useful progress. Also use when the user invokes Stop That
  Shit or asks to remove overengineering.
license: MIT
---

# Stop That Shit · Piik

## 项目取舍

Piik 是供朋友分享的小项目。优先简单、好用、漂亮和实际效果，积极采用有收益的成熟方案与新技术。
不要按假想的百万级规模设计，不要追求覆盖一切极端情况、无限兼容或零风险。
复杂度、验证时间和维护负担都是真实成本。用户已经授权的合理工作，应当推进到可用结果。

这是用户要求的提炼，也是本地工作尺度。与 [Ponytail](../ponytail/SKILL.md) 一起使用；
验证范围按本规则取舍，不机械执行通用 skill 的“每个非平凡改动都新增测试”。
[AGENTS.md](../../../AGENTS.md) 和 [CONTRIBUTING.md](../../../CONTRIBUTING.md)
继续拥有权限、产品约束和交付流程。

## 直接执行

- **先理解，再动手。** 沿实际调用链找到错误最早出现的位置，在现有职责内修复。
  已有代码、标准库、平台或依赖能完成就复用。允许改够必要的地方，不以最少行数牺牲根因修复。
- **让研究产生实现。** 参考相关的一手实现，选出简单、可逆的方案就做对照。
  一旦信息足够做决定，停止搜集同类材料。上游也有问题不等于只能接受；检查现有配置、
  接口和小范围补丁。不能证明绝对安全，不是停止一个已授权实验的理由。
- **防御放在真实边界。** 保留鉴权、外部输入校验和必要的资源释放；内部已验证事实直接使用。
  不逐层重复校验，不用空值、假成功或静默兜底掩盖错误。新增重试、状态、开关或限制必须
  对当前可达问题有作用；“以后可能用上”“以防万一”不构成理由。
- **兼容只服务现有承诺。** 按已发布的兼容约定处理真实消费者；不为废弃实验、未发布旧代码
  或想象中的客户端保留双读写、别名和迁移层。不要把内部实现变化一律升级成协议问题。
- **验证要回答问题。** 优先使用已有检查或复现，验证用户能观察到的结果；必要时加一个能
  抓住真实回归的检查。小文案、布局和可逆低影响改动不默认新增单元测试；不为每个分支、
  私有函数、实现细节或检查工具再造测试。不同断言只有覆盖不同的实际失败才值得保留。
- **已回答的问题不要反复验。** 相关代码、依赖、环境或证据没有变化，就复用有效结果。
  失败后检查具体原因；修正后重跑受影响部分。全套检查按交付阶段执行，不在每次小改后重跑。
  不为“再放心一点”追加矩阵、审计代理、证明文件或验证流程；明确要求的专项验收照常完成。
- **减负要真正删掉。** 在当前范围内移除已替代实现、重复防御、无消费者的产物和重复测试。
  不留注释代码、停用分支、过渡接口或长篇历史说明。仅用于本次调查的探针留在 ignored
  工作目录；值得长期保留的事实更新现有文档所有者，不再建一套审计账本。
- **交付有用结果。** 已授权的必要工作继续做，不停在计划、风险清单或“可以继续”。
  功能完成、相关检查通过且没有已知阻断就收口；真正受阻时说明具体缺口和已尝试的方法。
  不把未知说成已解决，也不把所有未知都变成发布门槛。汇报结果和影响决定的限制即可，
  不用测试数量、长免责声明、反复道歉或未来待办替代成果。

## 用在 Piik 上

| 遇到的问题 | 应采取的动作 |
| --- | --- |
| 画质恢复慢 | 对比现有适配策略的恢复时间与持续弱网表现；有明确收益就采用。不要仅因上游也慢而停手，也不要另造周期重置器。 |
| 小控件错位 | 修布局，查看受影响的尺寸与状态；不启动全仓库网络验收。 |
| 同一事实到处加判断 | 修正它的生产者和生命周期，让消费者使用可靠结果；删掉重复分支。 |
| 检查已经通过 | 完成当前交付；只有新变化、失败或尚未回答的实际问题才扩大验证。 |

这些是做判断的尺度，不要求为它们生成清单、报告或新工具。

## 参考与取舍

2026-10-16 查阅；以下经验结合项目需求独立整理，社区反馈是案例，不是模型效果的统计证明。

- [Stop That Shit](https://github.com/lennney/stop-that-shit/blob/0.2.4/skills/stop-that-shit/SKILL.md)：额外动作须有当前用途，任务要完成，验证循环要结束。
- [STSS](https://github.com/lennney/stop-that-shit/blob/0.2.4/skills/stss/SKILL.md)：只保留影响读者决定的限定，减少自我辩护。
- [Avoid Over-Defensive Programming](https://github.com/aravelo7/codex-agent-skills/blob/main/skills/avoid-overdefensive-programming/SKILL.md)：修正错误源头，避免假成功和静默兜底；不引入其逐分支报告流程。
- [Ponytail](../ponytail/SKILL.md)：复用现成能力，选最小正确实现；验证要求服从本地任务尺度。
- [社区案例：小任务膨胀](https://www.reddit.com/r/codex/comments/1vf5elq/how_do_you_stop_codexclaude_from_overengineering/)与[重复实现和返工](https://www.reddit.com/r/codex/comments/1ujnwxb/codex_quality_issues_in_realworld_coding_ignored/)：检查实际 diff 与交付价值，避免用更多流程治理过多流程。
