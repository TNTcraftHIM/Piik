# 参与 Piik 翻译

[English](./translating.md) · [贡献指南](../../CONTRIBUTING.md)

Piik 目前提供简体中文和英文。欢迎改进按钮措辞、校对教程，或参与其他语言的翻译。
翻译建议和修改通过 GitHub Issue 与 Pull Request（PR）讨论、审核。

只想改一句话，可以直接[提交建议](https://github.com/TNTcraftHIM/Piik/issues/new/choose)：
写明语言、页面或控件、原文、建议译文及理由。附上截图或进入该页面的步骤，便于理解上下文；
截图中请移除私人邀请链接、密码和个人内容。提交措辞建议无需搭建开发环境。

## 从一处修改开始

1. 先试用对应界面，看看附近有哪些操作。必要时对照中英文理解含义；
   角色名称、术语与文风以[命名和文案规范](../reference/naming.md#voice-and-terminology)为准。
2. Fork 仓库，从当前 `main` 创建工作分支，按[贡献流程](../../CONTRIBUTING.md#lean-workflow)修改。
   少量文字也可以通过 GitHub 文件编辑器提出修改。
3. 在下表对应的文件里查找原文。语言文件中只修改冒号后的译文，保留键名和占位符。
   找到键名后，可以搜索它在哪些界面使用，例如：

   ```sh
   rg -n -F 'host.title' src/client
   ```

4. 预览对应界面并运行[相关检查](#预览与检查)。仅修正某种语言的错字时，修改该语言即可；
   如果调整的是功能含义，需要同步所有已登记语言中的对应内容。
5. 向 `main` 提交 PR，说明原文的问题、修改的语言和页面，以及检查结果。
   没有条件预览的部分请如实说明，维护者可以协助验证。
   PR 格式及发布流程见[贡献指南](../../CONTRIBUTING.md#pull-request-scope)。

## 文案在哪里

| 内容 | 修改位置 |
| --- | --- |
| App 启动页、网页端与 App 共用的操作界面，含 tooltip 和无障碍标签 | [英文词库](../../src/client/locales/en.ts)、[中文词库](../../src/client/locales/zh.ts) |
| 随机欢迎语、浏览器标签页的轮换标题 | 同一语言文件中的 `welcome.*` 及文件末尾的标题词库 |
| 官网 | [页面正文](../../site/index.html)和[交互文案](../../site/main.js)，按 `en`、`zh-CN` 成对组织 |
| 宣传短片 | [短片源码说明](../../site/film/README.md)，字幕、插画和播放控件有各自的中英文内容 |
| App 黑窗口 | [console.go](../../internal/app/console.go) 中的 `consoleCopy`，每项按英文、中文、纯视觉排列；第三项即使为空也需保留 |
| README 与入门教程 | [README](../../README.md)、[使用指南](./getting-started.md)、[部署指南](../operations/self-hosting.md)，均有对应的 `.zh-CN.md` 文件 |

App 与 Server 使用同一套网页操作界面。请修改源码，构建目录和发布包由工具生成。
应用词库中的修改不会自动翻译官网文案；操作名称变化时，也要检查相关教程。
技术参考文档保留一份公共版本，详见[文档职责](../maintenance.md)。

## 翻译时保留什么

按目标语言的习惯表达，角色和密码名称沿用公共术语表。介绍可以轻松，操作、错误和部署步骤要清楚。
性能、平台、连接条件等限制应保留原意。梗和彩蛋应让不懂出处的人也能理解。
机器辅助翻译需要由理解目标语言和使用场景的人校对；原文本身有歧义时，在 PR 中说明。

语言文件使用 TypeScript 对象。下面是现有的一组内容：

```ts
// en.ts
"host.title": "{name}'s screen",
// zh.ts
"host.title": "{name} 的屏幕",
```

`host.title` 是程序查找文案的键名，`{name}` 由程序填入。
可以调整占位符的位置，但要保留拼写、花括号和出现次数。
当前格式化函数对每个变量替换一次；重复写 `{name}` 会让第二处仍显示占位符。
词库使用普通字符串，不解析 HTML 或 ICU 复数表达式。
如果目标语言需要复数变化或不同的句子组合，请给出具体例子，便于连同调用处一起调整。

保留代码的引号、转义和逗号。命令、配置项、URL、下载文件名，以及 Go 黑窗口文案中的 `%s`
等格式标记保持原样。链接显示文字和图片说明可以翻译；Markdown 标题变化后，要修正对应的页内链接。
许可证原文及第三方声明保持完整。

## 新增一种语言

先搜索是否已有相关 Issue 或 PR。准备翻译较多内容时，可以开一个 Issue，说明语言代码、
翻译范围，以及术语或排版疑问，方便大家分工和校对。

1. 复制 `src/client/locales/en.ts`，例如命名为 `fr.ts`。翻译正文和轮换标题，修改两个导出变量名，
   保留从 `zh.ts` 引入的 `Record<CopyKey, string>`、`TitleFrameCatalog` 类型。
   中文词库目前定义键名集合，理解内容时可以参考任一现有语言。
   请补全全部键名，不要用展开英文词库的方式填充缺失译文。
2. 在 [locales/index.ts](../../src/client/locales/index.ts) 中导入两个导出变量，并添加一项登记。
   例如，**完成这两个词库的翻译后**：

   ```ts
   fr: { name: "Français", short: "FR", tag: "fr", copy: fr, titleFrames: frTitleFrames },
   ```

   文件名和键名使用 ASCII 语言代码，`name` 填写该语言自己的名称，`short` 填写按钮简称，
   `tag` 填写对应语言标签。简称采用一至三个易识别的字符，例如 `中`、`EN`、`FR`；
   同时提供地区或文字变体时，简称也应能区分。
   此登记供语言控件、页面语言、偏好保存及 App 启动跳转共用。
   中文、英文和纯视觉保留直接切换按钮；有其他语言时，在纯视觉后增加一个共用的下拉入口。
   选中额外语言后，该格显示它的简称，菜单内显示全名。
   首次使用先匹配已登记的标签或键名，再匹配基础语言；没有对应翻译时使用英文。
   用户保存的选择优先。
   App、Server 网页界面及官网对中文地区和文字变体的默认选择，遵循
   [统一的系统语言规则](../product/presentation-lifecycle.md#visual-language)。
3. 检查完整界面与启动流程。新增的界面语言在 App 黑窗口中暂用英文；
   翻译黑窗口时，还需同步启动服务和 loopback 对语言的校验，相关位置见
   [App 模块地图](../reference/engineering.md#module-map)。
4. 在 PR 中写清覆盖范围。官网、短片和文档可以分别翻译，新增语言时需同步各自的语言切换入口。
   从右向左书写的语言还需要验证文字方向与布局；仅有词库并不代表已支持 RTL 排版。

纯视觉模式是可选的呈现方式，不是另一种待翻译语言。小漫画和文字模式共用，
它们的文字标签与说明在普通词库中翻译，保留现有纯视觉选项即可。

## 预览与检查

Node/npm 版本及本地启动方法见[从源码运行](../README.md#run-from-source)。
修改应用词库后，在仓库根目录执行：

```sh
npm ci
npm run typecheck
npm test -- tests/copy.test.ts
```

类型检查能发现缺少的键名；文案测试会检查已登记词库的空文案、占位符不一致，
以及语言选择和启动跳转。测试不能代替语言质量的校对。

按源码指南启动本地界面与服务端，通过右上角控件选择语言，进入被修改的页面。
结合长昵称、数量等实际内容，检查窄窗口、键盘焦点、tooltip 和无障碍标签。
登记额外语言后，检查下拉菜单在视口边缘仍可操作，并能向辅助技术提供展开与收起状态。
新增语言还应检查刷新、App 启动、切回英文及纯视觉模式。
按完整语义断句，避免用空格或强制换行去适配单一桌面尺寸。

官网与短片使用[官网预览流程](../operations/website.md#preview)。
Markdown 修改在暂存新文件后执行 `node scripts/check-docs.mjs`，并检查 GitHub 渲染结果与翻译后的链接。
涉及代码时，额外检查按[贡献指南](../../CONTRIBUTING.md#verification-entrypoints)执行。

## 延伸阅读

核对日期：2026-09-13。以下资料提供上下文校对与语法保留的通用方法，
Piik 的提交流程以本页和贡献指南为准。

- [OBS 翻译指南](https://github.com/obsproject/obs-studio/wiki/How-To-Contribute-Translations-For-OBS)：在运行中的界面校对，理解技术术语。
- [Godot 翻译指南](https://contributing.godotengine.org/en/latest/other/translations.html)：查找源码上下文，协作统一术语。
- [Weblate 翻译说明](https://docs.weblate.org/en/latest/user/translating.html#translating-special-text-safely)：处理占位符与标记语法。
- [W3C 语言标签指南](https://www.w3.org/International/questions/qa-choosing-language-tags)：用 BCP 47 标签区分语言及其变体。
- [Unicode CLDR 语言名称](https://cldr.unicode.org/translation/displaynames/languagelocale-names)：菜单名称的参考来源，也可以用浏览器的 `Intl.DisplayNames` 查找语言本名。Piik 按钮上的一至三个字符由项目选定，不是 CLDR 规定的标准简称；随经过校对的译文一起维护在语言登记表中。
