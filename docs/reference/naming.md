# Naming And Copy

This is the naming convention for new and changed Piik code, UI and packaging.
Use the brand for people and predictable lowercase identifiers for tools.

## Voice And Terminology

Use the same role and action vocabulary in the App, Browser, website and guides.
Role labels describe permission; a person's chosen nickname stays unchanged.

| Meaning | English | Chinese |
| --- | --- | --- |
| Person sharing and controlling the room | Host | 房主 |
| Person watching | Viewer | 观众 |
| Product capability | Screen sharing | 屏幕共享 |
| Start sending a chosen screen/window | Start sharing | 开始分享 |
| Enter another person's room | Join a room | 加入房间 |
| Site-wide access secret | Site passphrase | 站点口令 |
| Room-specific access secret | Room password | 房间密码 |

Write each language for its own audience. Chinese headings and welcomes may
sound like friends inviting each other: “来，给你看个好东西。” or “沙发给你留着呢。”
Do not translate English sentence structure or possessive screen metaphors
literally (“和朋友一起看你的屏幕”). Use familiar Chinese verbs and a light touch;
forced memes, baby talk and repeated slogans quickly become tiring.

Set the register by the reader's task:

| Surface | Register |
| --- | --- |
| Website | Light, everyday language in introductions and illustration captions; keep the current restraint |
| README | A friendly introduction, followed by direct explanations of features, limits and first steps |
| Documentation index | Clear topic names and short descriptions that help readers choose a guide |
| Deployment, configuration and maintenance guides | Formal, precise instructions: prerequisites, actions, expected results and recovery steps |

Formal means clear and factual, not bureaucratic. Keep detailed procedures free
of jokes and promotional slogans; do not carry the website's playful headings
into technical instructions.

Download/availability labels, platform requirements, instructions, permission
prompts, status and errors stay plain and specific. Use the exact visible action
names in tutorials; a playful caption never replaces “Download”, “Join a room”
or a platform/connection limitation. Explain what happened, what the user can do
next, and any real limitation. Jokes belong
in the welcome or illustration caption. Do not soften a failure into a joke,
invent connection progress or promise guaranteed connectivity or absolute privacy.
Screen sharing includes games, creative work and showing a useful discovery.

Opening lines are original, brief nods to game and movie conventions. Keep a
small bilingual set without a quotation service or attribution to real works.
Avoid copying recognizable dialogue, catchphrases or an existing brand's voice.
The [visual language](../design/visual-language.md) owns where these lines appear.

## Product And Tool Names

| Surface | Convention | Example |
| --- | --- | --- |
| Product and repository | `Piik` | `TNTcraftHIM/Piik` |
| Standalone application | `Piik App` | Window title, documentation, shortcuts |
| Hosted service in prose | `Piik Server` | Deployment instructions |
| Executables and command directories | Lowercase, hyphen-separated | `piik-app[.exe]`, `piik-server[.exe]`, `cmd/piik-app` |
| Native capture executable | Lowercase component name | `piik-capture[.exe]` |
| Download archives | Lowercase, target and revision suffix | `piik-app-windows-amd64-<revision>.tar.gz` |
| Package/build directory names | Lowercase and target suffix | `piik-app-windows-amd64` |
| macOS application bundle | Display name, standard extension | `Piik App.app` |
| Linux desktop entry | Lowercase file/Exec, display Name | `piik-app.desktop`, `Exec=piik-app`, `Name=Piik App` |
| Package and service identifiers | Lowercase | npm `piik`, systemd `piik.service`, `tv.piik.app` |
| Environment variables | Uppercase snake case | `PIIK_DEBUG`, `PIIK_LOG_DIR` |
| Go module path | Exact repository spelling | `github.com/TNTcraftHIM/Piik` |

An `.exe` is lowercase on Windows too; `.app` is a user-facing bundle, not the
raw executable. There is no universal OS rule requiring lowercase binaries:
this project chooses one spelling across platforms for predictable commands.
Archive contents and directory layout are owned by the existing packager; a
name change does not change that layout.
Keep platform/standard spellings such as `Info.plist`, `LICENSE`, `README.md`
and `REVISION`. Do not change third-party names or notices to fit this table.
Immutable measurement records keep the paths and hashes of their measured
revision; they are evidence rather than current command examples.

## Code ownership and vocabulary

The [engineering module map](./engineering.md#module-map) owns directory
responsibilities. HTTP/WebSocket clients, signaling `clientId`, protocol clients
and similar connection roles remain `client`; they do not name the standalone App.

- Follow each language's semantics: lowercase Go packages, exported `PascalCase`
  and unexported `camelCase`; existing TypeScript component/type conventions.
  Brand casing must not change visibility or create unnecessary name prefixes.

Renaming the standalone product is not a protocol or persistence change.
Keep discovery, wire and stored identifiers at their current contracts. Their
change rules belong to [versioning](./versioning.md); do not add aliases or dual
readers merely for a display rename.

## Basis

Reviewed 2026-09-10. Desktop standards explicitly separate display names from
executable identifiers; lowercase executable names are our portability convention.

- [freedesktop desktop entries](https://specifications.freedesktop.org/desktop-entry/latest/recognized-keys.html): `Name`, `Exec`, `TryExec` and `Icon` are distinct fields.
- [Apple bundle keys](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/CoreFoundationKeys.html): `CFBundleDisplayName` and `CFBundleExecutable` have different responsibilities.
- [Syncthing desktop entry](https://github.com/syncthing/syncthing/blob/main/etc/linux-desktop/syncthing-start.desktop): a mature cross-platform example of display branding and lowercase commands.
- [Effective Go naming](https://go.dev/doc/effective_go#names): package and identifier casing carries language conventions and visibility semantics.
