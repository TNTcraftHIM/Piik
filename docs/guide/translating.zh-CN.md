# 参与 Piik 翻译

[English](./translating.md) · [贡献指南](../../CONTRIBUTING.md)

Piik 提供简体中文和英文，可通过 GitHub Issue 与 Pull Request（PR）建议措辞、修正译文或新增语言。

只想改一句话，可以直接[提交建议](https://github.com/TNTcraftHIM/Piik/issues/new/choose)：
写明语言、页面或控件、原文、建议译文及理由。附上截图或进入该页面的步骤，便于理解上下文；
截图中请移除私人邀请链接、密码和个人内容。提交措辞建议无需搭建开发环境。

## 从一处修改开始

1. 先试用对应界面，看看附近有哪些操作。必要时对照中英文理解含义；
   角色名称、术语与文风以[命名和文案规范](../standards/naming.md#voice-and-terminology)为准。
2. Fork 仓库，从当前 `main` 创建工作分支，按[贡献流程](../../CONTRIBUTING.md#lean-workflow)修改。
   少量文字也可以通过 GitHub 文件编辑器提出修改。
3. 在下表对应的文件里查找原文。语言文件中只修改冒号后的译文，保留键名和占位符。
   找到键名后，可以搜索它在哪些界面使用，例如：

   ```sh
   rg -n -F 'host.title' src/client
   ```

4. 预览对应界面并运行[相关检查](#预览与检查)。仅修正某种语言的错字时，修改该语言即可；
   如果调整的是功能含义，需要同步所有已登记语言中的对应内容。
5. 向 `main` 提交 PR，说明措辞问题、修改的语言和页面，以及预览结果。
   PR 格式见[贡献指南](../../CONTRIBUTING.md#pull-request-scope)。

## 文案在哪里

| 内容 | 修改位置 |
| --- | --- |
| App 启动页、网页端与 App 共用的操作界面，含 tooltip 和无障碍标签 | [英文词库](../../src/client/locales/en.ts)、[中文词库](../../src/client/locales/zh.ts) |
| 欢迎语、等待短句、浏览器标签页的轮换标题 | 同一语言文件中的 `zhPlayful` / `enPlayful` 及标题词库；官网欢迎语共用这些词库 |
| 官网 | [页面正文](../../site/index.html)和[交互文案](../../site/main.js)，按 `en`、`zh-CN` 成对组织 |
| 宣传短片 | [短片源码说明](../../site/film/README.md)，字幕、插画和播放控件有各自的中英文内容 |
| 3.0 域与房间专用文案 | [频道组件](../../src/client/channel/components)和[房间页面](../../src/client/pages/ChannelPreviewPage.tsx)中的中英文配对文本；共用控件仍使用上方词库 |
| README 与读者文档 | [README](../../README.md)、[文档首页](./README.md)、[使用指南](./getting-started.md)、[问题排查](./troubleshooting.md)、[部署指南](../operations/self-hosting.md)，均有对应的 `.zh-CN.md` 文件 |

修改源码后，重新构建提供该内容的页面或程序：

- **App/Server 界面：** 词库随网页资源打包，需发布更新后的 App 或 Server；远程站点的界面由该 Server 提供。
- **官网与短片：** 使用[官网工作流](../operations/website.md)。
- **指南：** 文档网站在下次发布时从仓库 Markdown 生成，导航与搜索文案位于 `site/docs/`。

操作名称变化时，同步相关教程。技术参考保留一份公共版本，详见[文档职责](../standards/documentation.md)。

## 翻译时保留什么

按目标语言的习惯表达，角色和密码名称沿用公共术语表。介绍可以轻松，操作、错误和部署步骤要清楚。
性能、平台、连接条件等限制应保留原意。梗和彩蛋应让不懂出处的人也能理解。
机器辅助翻译需要由理解目标语言和使用场景的人校对；原文本身有歧义时，在 PR 中说明。

App 启动错误需同步修改共用启动页与错误说明，保留 Rust 运行时原因代码和原始技术详情。

语言文件使用 TypeScript 对象。下面是现有的一组内容：

```ts
// en.ts
"host.title": "{name}'s screen",
// zh.ts
"host.title": "{name} 的屏幕",
```

保留查找键名 `host.title`。可调整 `{name}` 的位置，保留其拼写、花括号和出现次数。
格式化函数对每个变量替换一次，使用普通字符串。需要复数、HTML 或其他句子组合时，
在 PR 中给出具体需求，连同调用处与格式化函数一起调整。

保留代码的引号、转义和逗号。命令、配置项、URL、下载文件名以及
等格式标记保持原样。链接显示文字和图片说明可以翻译；Markdown 标题变化后，要修正对应的页内链接。
许可证原文及第三方声明保持完整。

## 新增一种语言

先搜索是否已有相关 Issue 或 PR。准备翻译较多内容时，可以开一个 Issue，说明语言代码、
翻译范围，以及术语或排版疑问，方便大家分工和校对。

1. 复制 `src/client/locales/en.ts`，例如命名为 `fr.ts`。翻译正文与标题标签，按语境编写
   [俏皮话](#俏皮话)，修改三个导出变量名。
   保留从 `zh.ts` 引入的 `Record<CopyKey, string>`、`TitleFrameCatalog`、`PlayfulCatalog` 类型。
   中文词库目前定义键名集合，理解内容时可以参考任一现有语言。
   请补全全部键名，不要用展开英文词库的方式填充缺失译文。
2. 在 [locales/index.ts](../../src/client/locales/index.ts) 中导入三个导出变量，并添加一项登记。
   例如，**完成词库翻译后**：

   ```ts
   fr: { name: "Français", short: "FR", tag: "fr", copy: fr,
     titleFrames: frTitleFrames, playful: frPlayful },
   ```

   文件名和键名使用 ASCII，`name` 使用语言本名，`short` 使用一至三个易识别的字符，
   `tag` 使用对应语言标签；同时提供地区或文字变体时，简称应能区分。
   额外语言显示在纯视觉模式后的共用下拉菜单中。
   按[系统语言规则](../standards/presentation-lifecycle.md#visual-language)检查初始选择、偏好保存与 App 跳转。
3. 检查完整界面与启动流程，包括启动页、房间以及错误状态。专用配对文本不会自动继承
   词库中的新语言；在 PR 中明确这些页面的覆盖范围，相关位置见
   [模块地图](../standards/engineering.md#module-map)。
4. 在 PR 中写清覆盖范围。官网、短片和文档可以分别翻译，新增语言时需同步各自的语言切换入口。
   从右向左书写的语言还需实现并检查文字方向与布局。

纯视觉模式的文字标签与说明在普通词库中翻译，保留这个呈现选项即可。

## 俏皮话

各语言独立维护欢迎语、等待短句数组；可轮换标题由固定的 `label` 和 `variations` 数组组成。
可以单独增删某种语言的条目，不要求与其他语言的数量、顺序或梗一一对应。
空数组不显示装饰文案；只有一条时保持静止。操作键名和标题标签仍须完整翻译，
错误、暂停、结束、必需操作提示及 slogan 保持固定。

欢迎语每项包含 `text` 和两个 `symbols`，从现有的
[图标词汇](../../src/client/ui/icons.tsx)中选择能表达这句话的图形，用于纯视觉暗号。例如：

```ts
{ text: "沙发给你留着呢。", symbols: ["couch", "heart"] },
```

等待短句直接写成字符串，例如 `"先搬个小板凳。"`。短句应简洁、自然、符合所在场景；
避免时效热点、直接照搬台词，以及虚构进度、成功状态或剩余时间的说法。

轮换时间遵循[俏皮话生命周期](../standards/visual-language.md#playful-copy-lifecycle)。
欢迎语及其暗号在 `/__tooltip-preview` 预览；等待短句与标题在 `/__status-preview` 预览。
检查窄窗口和切换语言的效果。官网构建会自动使用更新后的欢迎语，其他官网文案单独维护。

## 预览与检查

Node/npm 版本及本地启动方法见[从源码运行](../README.md#run-from-source)。
修改应用词库后，在仓库根目录执行：

```sh
npm ci
npm run typecheck
npm test -- tests/copy.test.ts
```

这些检查覆盖缺少键名、空文案、占位符、语言选择和启动跳转；同时在运行界面中校对译文。

按源码指南启动本地界面与服务端，通过右上角控件选择语言，进入被修改的页面。
结合长昵称、数量等实际内容，检查窄窗口、键盘焦点、tooltip 和无障碍标签。
登记额外语言后，检查下拉菜单在视口边缘仍可操作，并能向辅助技术提供展开与收起状态。
新增语言还应检查刷新、App 启动、切回英文及纯视觉模式。
按完整语义断句，避免用空格或强制换行去适配单一桌面尺寸。

官网与短片使用[官网预览流程](../operations/website.md#preview)。
Markdown 修改在暂存新文件后执行 `node scripts/check-docs.mjs`，并检查 GitHub 渲染结果与翻译后的链接。
涉及代码时，额外检查按[贡献指南](../../CONTRIBUTING.md#verification-entrypoints)执行。

## 延伸阅读

- [OBS 翻译指南](https://github.com/obsproject/obs-studio/wiki/How-To-Contribute-Translations-For-OBS)：在运行中的界面校对，理解技术术语。
- [Godot 翻译指南](https://contributing.godotengine.org/en/latest/other/translations.html)：查找源码上下文，协作统一术语。
- [Weblate 翻译说明](https://docs.weblate.org/en/latest/user/translating.html#translating-special-text-safely)：处理占位符与标记语法。
- [W3C 语言标签指南](https://www.w3.org/International/questions/qa-choosing-language-tags)：用 BCP 47 标签区分语言及其变体。
- [Unicode CLDR 语言名称](https://cldr.unicode.org/translation/displaynames/languagelocale-names)：菜单名称参考，也可用浏览器 `Intl.DisplayNames` 查找语言本名；Piik 按钮简称在登记表中选定。
