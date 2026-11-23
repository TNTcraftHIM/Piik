//! The terminal presents App lifecycle events; the launcher owns their state.
use std::io::IsTerminal;

pub(super) struct Console {
    language: Option<&'static str>,
    color: bool,
}

impl Console {
    pub fn new(language: Option<&str>) -> Self {
        let language = match language {
            Some("zh" | "zh-Hant") => Some("zh"),
            Some("en") => Some("en"),
            _ => None,
        };
        let ansi = match std::env::var("TERM") {
            Ok(term) => !term.is_empty() && term != "dumb",
            Err(_) => std::env::var_os("WT_SESSION").is_some(),
        };
        let color =
            std::io::stderr().is_terminal() && std::env::var_os("NO_COLOR").is_none() && ansi;
        Self { language, color }
    }

    fn text(&self, english: &str, chinese: &str) -> String {
        text(self.language, english, chinese)
    }

    fn paint(&self, code: u8, text: &str) -> String {
        if self.color {
            format!("\x1b[{code}m{text}\x1b[0m")
        } else {
            text.into()
        }
    }

    pub fn startup(&self, version: &str, revision: &str, port: u16) {
        let revision =
            if revision.len() == 40 && revision.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                &revision[..7]
            } else {
                revision
            };
        eprintln!(
            "Piik App {version} [{revision}]\n{}",
            self.paint(32, &self.text("App is ready", "App 已就绪"))
        );
        self.launcher(port);
        eprintln!("\n {}\n", self.text("Ctrl+C to quit", "按 Ctrl+C 正常退出"));
    }

    fn launcher(&self, port: u16) {
        eprintln!(
            "\n {}\n {}",
            self.text("App launcher", "App 启动页"),
            self.paint(34, &format!("http://127.0.0.1:{port}/client"))
        );
    }

    pub fn starting(&self, public: bool) {
        let label = if public {
            self.text("Starting public invitation...", "正在连接公网邀请…")
        } else {
            self.text("Starting local network...", "正在启动局域网…")
        };
        eprintln!("\n {}", self.paint(34, &label));
    }

    pub fn ready(&self, local: &str, invitation: &str, configured_public: bool) {
        eprintln!(
            "\n {}",
            self.paint(32, &self.text("Site ready", "站点已就绪"))
        );
        for address in site_addresses(
            self.language,
            Some(local),
            Some(invitation),
            configured_public,
        )
        .into_iter()
        .flatten()
        {
            eprintln!("{address}");
        }
    }

    pub fn failed(&self, port: u16) {
        eprintln!(
            "\n {}\n {}",
            self.paint(31, &self.text("Site unavailable", "站点暂不可用")),
            self.text(
                "Open the App launcher to try again.",
                "请在 App 启动页重试。",
            )
        );
        self.launcher(port);
    }

    pub fn stopped(&self) {
        eprintln!("\n {}", self.text("App stopped", "App 已退出"));
    }
}

fn text(language: Option<&str>, english: &str, chinese: &str) -> String {
    match language {
        Some("en") => english.into(),
        Some("zh") => chinese.into(),
        _ => format!("{english} / {chinese}"),
    }
}

fn display_address(value: &str) -> Option<String> {
    let mut url = url::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string())
}

pub(super) fn site_addresses(
    language: Option<&str>,
    local: Option<&str>,
    invitation: Option<&str>,
    configured_public: bool,
) -> [Option<String>; 2] {
    let (invitation_english, invitation_chinese) = if configured_public {
        ("Configured public address", "已配置的公开地址")
    } else {
        ("Invitation address", "邀请地址")
    };
    [
        ("Local entry", "本机入口", local),
        (invitation_english, invitation_chinese, invitation),
    ]
    .map(|(english, chinese, value)| {
        let address = display_address(value?)?;
        Some(format!("{}\n  {address}", text(language, english, chinese)))
    })
}
