//! The terminal presents App lifecycle events; the launcher owns their state.
use std::io::IsTerminal;

pub(super) struct Console {
    language: Option<&'static str>,
    color: bool,
}

impl Console {
    pub fn new(language: Option<&str>) -> Self {
        let language = match language {
            Some("zh") => Some("zh"),
            Some("en") => Some("en"),
            Some("vis") => Some("vis"),
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

    fn text(&self, english: &str, chinese: &str, visual: &str) -> String {
        match self.language {
            Some("en") => english.into(),
            Some("zh") => chinese.into(),
            Some("vis") => visual.into(),
            _ => format!("{english} / {chinese}"),
        }
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
            r#"
     \ /
 .----v----.   Piik App
 | o     - |   {version}
 '---------'   {revision}
   /     \

 ------------------------------------
 {}"#,
            self.paint(32, &self.text("App is ready", "App 已就绪", "+"))
        );
        self.launcher(port);
        eprintln!(
            "\n {}\n",
            self.text("Ctrl+C to quit", "按 Ctrl+C 正常退出", "Ctrl+C")
        );
    }

    fn launcher(&self, port: u16) {
        eprintln!(
            "\n {}\n {}",
            self.text("App launcher", "App 启动页", "App"),
            self.paint(34, &format!("http://127.0.0.1:{port}/client"))
        );
    }

    pub fn starting(&self, public: bool) {
        let label = if public {
            self.text(
                "Starting public invitation...",
                "正在连接公网邀请…",
                "... ↗",
            )
        } else {
            self.text("Starting local network...", "正在启动局域网…", "... LAN")
        };
        eprintln!("\n {}", self.paint(34, &label));
    }

    pub fn ready(&self, site: &str) {
        eprintln!(
            "\n {}\n {}\n {}",
            self.paint(32, &self.text("Site ready", "站点已就绪", "+ ↗")),
            self.text("Site address", "站点地址", "↗"),
            self.paint(34, site)
        );
    }

    pub fn failed(&self, port: u16) {
        eprintln!(
            "\n {}\n {}",
            self.paint(31, &self.text("Site unavailable", "站点暂不可用", "!")),
            self.text(
                "Open the App launcher to try again.",
                "请在 App 启动页重试。",
                "↻ App"
            )
        );
        self.launcher(port);
    }

    pub fn stopped(&self) {
        eprintln!("\n {}", self.text("App stopped", "App 已退出", "-"));
    }
}
