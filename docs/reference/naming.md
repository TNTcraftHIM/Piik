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
sound like friends inviting each other: “叫朋友来一起看。” or “沙发给你留着呢。”
Do not translate English sentence structure or possessive screen metaphors
literally (“和朋友一起看你的屏幕”). Use familiar Chinese verbs and a light touch;
forced memes, baby talk and repeated slogans quickly become tiring.

The brand line is “Share the good stuff.” in English and “来，看点好康的。” in
Chinese. Display the Chinese headline on two lines: “来，看点” / “好康的。”
Keep metadata and ordinary prose as the continuous sentence.

Keep the public brand line consistent in the homepage, film ending and README
opening, beside a plain screen-sharing description. Scene titles should name
the action or benefit; do not turn every section into another slogan. Games, drawings, photos and
movie nights show the range of screen sharing without implying voice chat,
shared input or synchronized playback controls. Each locale must read naturally
as a complete sequence, without depending on a pun from the other language.

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

State the requirement, action or result directly. Omit negative comparisons that
answer an abandoned design or an internal discussion: “解压后运行” is enough;
listing the runtimes a packaged App does not require adds no useful next step.
Include an exclusion only when it resolves a real reader choice or limitation.

Write tutorials from an explicit starting point: what the reader needs, which
visible action to take, and what appears next. Distinguish watching an invitation,
creating an App room, using an existing site, and deploying a server. Say where
the site or download comes from; “follow the prompts” cannot stand in for a
missing prerequisite. Mark passwords and audio options as conditional when they
are optional. Keep App and Server package names distinguishable at download links.
Public platform notes say what has been tested and invite useful feedback;
internal phrases such as “this phase's acceptance target” belong in status.

Present the public online site as a usable entry for real rooms and sharing.
Offer the App download first and direct browser use alongside it; keep the
site's P2P-only deployment conditions in its detailed guide.

Use progressive disclosure on the website and in the film:

| Information layer | Reader's question | Content |
| --- | --- | --- |
| First view: navigation, headings, feature cards, film titles | What does it do, how do I start, what does it cost? | Familiar actions and concrete benefits: “开箱即用”, “免费使用”, “朋友点开就能看” |
| Expanded details, supporting text and FAQ answers | Will this work for me, and why? | Platform/network conditions, explained technical terms and links to the relevant guide |
| README, wiki and operational guides | How do I configure, verify or troubleshoot it? | Exact action names, prerequisites, commands, configuration and evidence limits |

The layer follows the reader's task, not font size alone. Keep material costs,
availability and limitations beside the claim or action they qualify; do not
hide them behind a collapse. Never promote an implementation mechanism such as
encoding reuse or STUN as an unexplained headline. Explain technical terms on
first use even in detailed documentation. Plain wording must preserve the
original bounds: “开箱即用” does not promise offline use or guaranteed connection,
and reduced repeated work does not establish a universal CPU saving.
Lead performance copy with the user benefit (low latency, efficient sharing),
then explain the supporting mechanism and its conditions. “Lowest latency”,
“zero delay” and comparative resource savings require matching measurements;
an architectural preference alone does not establish a benchmark result.

Write Chinese and English headings independently. Break lines at complete
phrases, never inside a short action such as “画上两笔”. A decorative number must
have an adjacent meaning/unit (“使用费用 0 元”), and its label must remain visible
in both languages and at the smallest supported width. Check the actual rendered
headline after rotation and animation settle: all meaningful words need room
inside the frame. Oversized background lettering may crop; primary copy may not.

Download/availability labels, platform requirements, instructions, permission
prompts, status and errors stay plain and specific. Use the exact visible action
names in tutorials; a playful caption never replaces “Download”, “Join a room”
or a platform/connection limitation. Explain what happened, what the user can do
next, and any real limitation. Jokes belong
in the welcome or illustration caption. Do not soften a failure into a joke,
invent connection progress or promise guaranteed connectivity or absolute privacy.
Screen sharing includes games, creative work and showing a useful discovery.

Operational pages omit introductory sentences that repeat their controls.
Helper text should explain a meaningful choice or prevent an error.

Use short, contextual references in opening lines and illustration reactions.
A familiar expression may work when its ordinary meaning still makes sense to
someone who does not recognize it. Keep each language independent and avoid
long dialogue, borrowed brand slogans or a stream of unrelated memes. Match a
celebration to a visible successful action; it must not precede the result.
Keep the small bilingual set local, without a quotation service.
The [visual language](../design/visual-language.md) owns where these lines appear.

## Product And Tool Names

| Surface | Convention | Example |
| --- | --- | --- |
| Product and repository | `Piik` | `TNTcraftHIM/Piik` |
| Standalone application | `Piik App` | Window title, documentation, shortcuts |
| Hosted service in prose | `Piik Server` | Deployment instructions |
| Executables and command directories | Lowercase, hyphen-separated | `piik-app[.exe]`, `piik-server[.exe]`, `cmd/piik-app` |
| Native capture executable | Lowercase component name | `piik-capture[.exe]` |
| App download archives | Lowercase, fixed target name within each release | `piik-app-windows-amd64.zip` |
| Package/build directory names | Lowercase and target suffix | `piik-app-windows-amd64` |
| macOS application bundle | Display name, standard extension | `Piik App.app` |
| Linux desktop entry | Lowercase file/Exec, display Name | `piik-app.desktop`, `Exec=piik-app`, `Name=Piik App` |
| Package and service identifiers | Lowercase | npm `piik`, systemd `piik.service`, `tv.piik.app` |
| Environment variables | Uppercase snake case | `PIIK_DEBUG`, `PIIK_LOG_DIR` |
| Go module path | Exact repository spelling | `github.com/TNTcraftHIM/Piik` |

Use the same lowercase binary names across platforms for predictable commands.
`Piik App.app` is the user-facing macOS bundle. The packager owns archive contents
and directory layout.
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

Content layering reviewed 2026-09-12:
[NN/g's progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/)
defers secondary detail while preserving the primary task;
[GOV.UK's clear-language guidance](https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/writing-guidelines/clear-language/)
keeps specialist content understandable. The layer assignments and Chinese
examples above are Piik's application of those principles.
[NN/g's microcopy guidance](https://www.nngroup.com/articles/3-cs-microcopy/)
puts clarity before concision and character; this also guides the balance
between Piik's playful introductions and factual instructions.

Reviewed 2026-09-10. Desktop standards explicitly separate display names from
executable identifiers; lowercase executable names are our portability convention.

- [freedesktop desktop entries](https://specifications.freedesktop.org/desktop-entry/latest/recognized-keys.html): `Name`, `Exec`, `TryExec` and `Icon` are distinct fields.
- [Apple bundle keys](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/CoreFoundationKeys.html): `CFBundleDisplayName` and `CFBundleExecutable` have different responsibilities.
- [Syncthing desktop entry](https://github.com/syncthing/syncthing/blob/main/etc/linux-desktop/syncthing-start.desktop): a mature cross-platform example of display branding and lowercase commands.
- [Effective Go naming](https://go.dev/doc/effective_go#names): package and identifier casing carries language conventions and visibility semantics.
