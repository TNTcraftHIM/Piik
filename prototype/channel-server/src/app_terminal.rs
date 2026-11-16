//! Interactive terminal presentation. The App launcher remains the only service-state owner.
use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind},
    terminal,
};
use serde_json::Value;
use std::{
    io::{self, IsTerminal, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

/// Browser launch is external convenience work, never part of the App's joined runtime.
pub(super) fn open_browser(url: String) -> io::Result<oneshot::Receiver<io::Result<()>>> {
    let (send, receive) = oneshot::channel();
    thread::Builder::new()
        .name("piik-open-browser".into())
        .spawn(move || {
            let _ = send.send(open_url(&url));
        })?;
    Ok(receive)
}

fn open_url(url: &str) -> io::Result<()> {
    #[cfg(all(unix, not(any(target_os = "macos", target_os = "android"))))]
    {
        use std::process::{Command, Stdio};
        let desktop = ["DISPLAY", "WAYLAND_DISPLAY"]
            .iter()
            .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()));
        if !desktop {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "No desktop session; open the displayed URL in a browser",
            ));
        }
        // The terminal retains its input; the desktop launcher gets no stdio.
        let status = Command::new("xdg-open")
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(io::Error::other("Desktop browser launcher failed"))
        }
    }
    #[cfg(not(all(unix, not(any(target_os = "macos", target_os = "android")))))]
    webbrowser::open(url)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Command {
    Launcher,
    Site,
    Refresh,
    Diagnostics,
    Quit,
}

fn command(input: &str) -> Option<Command> {
    match input.trim().to_ascii_lowercase().as_str() {
        "o" => Some(Command::Launcher),
        "s" => Some(Command::Site),
        "r" => Some(Command::Refresh),
        "d" => Some(Command::Diagnostics),
        "q" | "quit" => Some(Command::Quit),
        _ => None,
    }
}

/// Only stdin belongs to this thread; cancellation is polled and joined on Drop.
struct Input {
    stopped: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Drop for Input {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub(super) struct Terminal {
    _input: Input,
    commands: mpsc::Receiver<Command>,
    notice: Option<String>,
    last: String,
}
impl Terminal {
    pub fn start(enabled: bool, notice: Option<&str>) -> Option<Self> {
        if !enabled
            || !io::stdin().is_terminal()
            || !io::stderr().is_terminal()
            || std::env::var("TERM").is_ok_and(|term| term == "dumb")
        {
            return None;
        }
        let (send, commands) = mpsc::channel(8);
        let stopped = Arc::new(AtomicBool::new(false));
        let end = stopped.clone();
        let thread = thread::Builder::new()
            .name("piik-terminal-input".into())
            .spawn(move || {
                // Canonical input preserves existing Ctrl+C handling and ordinary log newlines.
                // O/S/R/Q are submitted with Enter on every platform; no raw mode to restore.
                let mut line = String::new();
                while !end.load(Ordering::Acquire) {
                    match event::poll(Duration::from_millis(100)) {
                        Ok(false) => continue,
                        Err(error) => {
                            eprintln!("Terminal input unavailable: {error}");
                            break;
                        }
                        Ok(true) => {}
                    }
                    match event::read() {
                        Ok(Event::Key(key)) if key.kind == KeyEventKind::Press => match key.code {
                            KeyCode::Char(ch) if line.len() < 32 => line.push(ch),
                            KeyCode::Backspace => {
                                line.pop();
                            }
                            KeyCode::Enter => {
                                if let Some(action) = command(&line) {
                                    if send.try_send(action).is_err() && end.load(Ordering::Acquire)
                                    {
                                        break;
                                    }
                                }
                                line.clear();
                            }
                            _ => {}
                        },
                        Ok(Event::Resize(_, _)) => {
                            let _ = send.try_send(Command::Refresh);
                        }
                        Ok(_) => {}
                        Err(error) => {
                            eprintln!("Terminal input unavailable: {error}");
                            break;
                        }
                    }
                }
            })
            .ok()?;
        Some(Self {
            _input: Input {
                stopped,
                thread: Some(thread),
            },
            commands,
            notice: notice.map(clean),
            last: String::new(),
        })
    }
    pub async fn next(&mut self) -> Option<Command> {
        self.commands.recv().await
    }
    pub fn show(&mut self, state: &Value, force: bool) {
        let width = terminal::size()
            .map_or(64, |(width, _)| usize::from(width))
            .clamp(1, 100);
        let frame = render(state, self.notice.as_deref(), width);
        if force || frame != self.last {
            // Append only changed views. Existing errors remain observable in scrollback;
            // no cursor rewrites, alternate screen, log parser or duplicate history store.
            let mut out = io::stderr().lock();
            let _ = write!(out, "\n{frame}\n> ");
            let _ = out.flush();
            self.last = frame;
        }
    }
    pub fn message(&self, message: &str) {
        eprintln!("\n{}", clean(message));
    }
}

fn clean(text: &str) -> String {
    text.chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect()
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
fn render(state: &Value, notice: Option<&str>, width: usize) -> String {
    let version = clean(state["version"].as_str().unwrap_or("development"));
    let revision = clean(state["revision"].as_str().unwrap_or("development"));
    let short = if revision.len() == 40 && revision.bytes().all(|b| b.is_ascii_hexdigit()) {
        &revision[..8]
    } else {
        &revision
    };
    let mut lines = vec![
        format!("Piik  {version}  [{short}]"),
        "Browser companion / 浏览器伴侣".into(),
        "─".repeat(width),
    ];
    lines.push("App connection ready / App 连接服务已就绪".into());
    let status = if state["starting"].as_bool() == Some(true) {
        "Site starting / 站点正在启动"
    } else if state["reason"].is_string() {
        "Site unavailable / 站点暂不可用"
    } else if state["target"].is_string() {
        "Site ready / 站点已就绪"
    } else {
        "Standby · choose a site in the launcher / 待命，请在启动页选择站点"
    };
    lines.push(status.into());
    if let Some(notice) = notice.filter(|v| !v.is_empty()) {
        lines.push(format!("Notice / 提示: {}", clean(notice)));
    }
    if let Some(reason) = state["reason"].as_str() {
        lines.push(format!("Reason / 原因: {}", clean(reason)));
    }
    if let Some(port) = state["controlPort"].as_u64() {
        lines.push("Launcher / 启动页".into());
        lines.push(format!("  http://127.0.0.1:{port}/client"));
    }
    if let Some(target) = state["target"].as_str().and_then(display_address) {
        lines.push("Site entry / 站点入口".into());
        lines.push(format!("  {target}"));
    }
    let mut seen = std::collections::BTreeSet::new();
    if let Some(owned) = state["ownedSites"].as_array() {
        for value in owned
            .iter()
            .filter_map(Value::as_str)
            .filter_map(display_address)
        {
            if seen.insert(value.clone()) {
                lines.push(format!("Share address / 分享地址: {value}"));
            }
        }
    }
    lines.push("─".repeat(width));
    lines.push("O + Enter  Open launcher / 打开启动页".into());
    if state["target"].is_string() {
        lines.push("S + Enter  Open site / 打开当前站点".into());
    }
    lines.push("R + Enter  Refresh / 刷新状态".into());
    lines.push(if state["debug"].as_bool() == Some(true) {
        "D + Enter  Export App report / 导出 App 报告".into()
    } else {
        "D + Enter  App report · enable Debug in launcher first / App 报告，请先在启动页启用调试".into()
    });
    lines.push("Q + Enter  Quit normally / 正常退出   ·   Ctrl+C".into());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn view_uses_launcher_truth_without_exposing_private_entry() {
        let state = json!({"version":"v3.0.0-beta.test","revision":"a".repeat(40),"controlPort":39721,
            "target":"http://127.0.0.1:8787/?piik-client-port=39721#owner=secret&piik-client=1",
            "ownedSites":["http://127.0.0.1:8787/","https://192.0.2.1:8787/"]});
        let view = render(&state, Some("System WebView unavailable"), 32);
        assert!(view.contains("Site ready"));
        assert!(view.contains("192.0.2.1"));
        assert!(view.contains("[aaaaaaaa]"));
        assert!(view.contains("S + Enter"));
        assert!(!view.contains("secret"));
        assert!(!view.contains("piik-client"));
        assert!(!view.contains("owner="));
        assert!(view.contains(&"─".repeat(32)));
        let starting = render(&json!({"starting":true}), None, 20);
        assert!(starting.contains("Site starting"));
        assert!(!starting.contains("S + Enter"));
        assert!(render(
            &json!({"reason":"tunnel-timeout","detail":"private raw error"}),
            None,
            20
        )
        .contains("tunnel-timeout"));
        assert!(!render(
            &json!({"reason":"tunnel-timeout","detail":"private raw error"}),
            None,
            20
        )
        .contains("private raw error"));
    }
    #[test]
    fn input_is_explicit_and_does_not_treat_arbitrary_text_as_a_command() {
        assert_eq!(command(" Q "), Some(Command::Quit));
        assert_eq!(command("s"), Some(Command::Site));
        assert_eq!(command(" D "), Some(Command::Diagnostics));
        assert_eq!(command("open a different site"), None);
        assert_eq!(clean("x\u{1b}[31m\ny"), "x [31m y");
        assert_eq!(display_address("javascript:alert(1)"), None);
    }
    #[test]
    fn diagnostics_are_an_explicit_export_without_a_second_enabled_state() {
        assert!(render(&json!({"debug":true}), None, 44).contains("Export App report"));
        assert!(render(&json!({"debug":false}), None, 44).contains("enable Debug in launcher first"));
    }
}
