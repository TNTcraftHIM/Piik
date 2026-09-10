# Naming

This is the naming convention for new and changed Piik code, UI and packaging.
Use the brand for people and predictable lowercase identifiers for tools.

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

- `internal/app` owns the standalone application and its native/launcher
  components; `cmd/piik-app` is its thin command entry.
- `internal/server` owns the reusable room service and Hosted runtime;
  `cmd/piik-server` is its command entry. The App runs that same service for
  Local/public-link rooms, without a second backend implementation.
- `src/client` is the Browser frontend. HTTP/WebSocket clients, signaling
  `clientId`, protocol clients and similar connection roles remain `client`.
- Follow each language's semantics: lowercase Go packages, exported `PascalCase`
  and unexported `camelCase`; existing TypeScript component/type conventions.
  Brand casing must not change visibility or create unnecessary name prefixes.

Renaming the standalone product is not a protocol or persistence change.
Keep `piik-client-v9`, the discovery service name, Browser activation/storage
keys, the `Piik` configuration directory and diagnostic categories at their
current exact contracts. Change such identifiers only with a separate behavior
or contract decision; do not add aliases or dual readers for display renames.

## Basis

Reviewed 2026-09-10. Desktop standards explicitly separate display names from
executable identifiers; lowercase executable names are our portability convention.

- [freedesktop desktop entries](https://specifications.freedesktop.org/desktop-entry/latest/recognized-keys.html): `Name`, `Exec`, `TryExec` and `Icon` are distinct fields.
- [Apple bundle keys](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/CoreFoundationKeys.html): `CFBundleDisplayName` and `CFBundleExecutable` have different responsibilities.
- [Syncthing desktop entry](https://github.com/syncthing/syncthing/blob/main/etc/linux-desktop/syncthing-start.desktop): a mature cross-platform example of display branding and lowercase commands.
- [Effective Go naming](https://go.dev/doc/effective_go#names): package and identifier casing carries language conventions and visibility semantics.
