//! Windows owns presentation; the existing HTTP App owns all room and capture work.
mod console;
mod caption;
mod reveal;
mod watch_mount;
mod download;
mod page;
mod permission;
mod popup;

pub use console::attach as attach_console;

use crate::app::{self, Config};
use anyhow::{Context, Result};
use permission::{permissions, PendingPermissions, Prompt};
use serde::{Deserialize, Serialize};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::{
    cell::RefCell,
    rc::Rc,
    thread,
};
use tao::{
    dpi::{LogicalPosition, LogicalSize, PhysicalSize},
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget},
    platform::{
        run_return::EventLoopExtRunReturn,
        windows::{IconExtWindows, WindowBuilderExtWindows},
    },
    window::{Fullscreen, Icon, Window, WindowBuilder, WindowId},
};
use tokio::sync::oneshot;
use webview2_com::{
    ContainsFullScreenElementChangedEventHandler, WindowCloseRequestedEventHandler,
};
use wry::{
    NewWindowResponse, PageLoadEvent, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows,
    WebViewExtWindows,
};

const CONTROLS: &str = include_str!("../../../src/client/ui/window-controls.json");
const CAPTION: &str = include_str!("../../../src/client/ui/native-window-caption.html");
const MODAL_BACKDROP: &str = include_str!("../../../src/client/ui/modal-backdrop.css");
const PALETTE: &str = include_str!("../../../src/client/ui/palette.css");
const CAPABILITY: &str =
    "Object.defineProperty(window, 'piikNativeWindow', { value: 'integrated' });";
const SYSTEM_PRESENTATION: &str =
    "Object.defineProperty(window, 'piikNativeWindow', { value: 'system' });\
     (() => {\
       window.addEventListener('message', event => {\
         if (event.source !== window.opener || event.data?.type !== 'piik-native-window-presentation') return;\
         const message = event.data.message;\
         if (message?.kind === 'panel' || message?.kind === 'appearance') window.ipc.postMessage(JSON.stringify(message));\
       });\
       const ready = () => window.opener?.postMessage('piik-native-window-ready', '*');\
       if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', ready, { once: true });\
       else ready();\
     })();";

thread_local! {
    static APP_ICON: RefCell<Option<Icon>> = const { RefCell::new(None) };
}

pub(super) fn window_builder() -> Result<WindowBuilder> {
    APP_ICON.with(|cached| {
        let mut cached = cached.borrow_mut();
        if cached.is_none() {
            *cached = Some(Icon::from_resource(1, None)?);
        }
        let icon = cached.as_ref().expect("App icon loaded").clone();
        Ok(WindowBuilder::new()
            .with_window_icon(Some(icon.clone()))
            .with_taskbar_icon(Some(icon)))
    })
}

#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(owner: isize, text: *const u16, caption: *const u16, flags: u32) -> i32;
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Language {
    En,
    Zh,
    #[serde(rename = "zh-Hant")]
    ZhHant,
    Ja,
    Ko,
}
impl Language {
    fn code(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Zh => "zh",
            Self::ZhHant => "zh-Hant",
            Self::Ja => "ja",
            Self::Ko => "ko",
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Theme {
    Light,
    Dark,
}
impl Theme {
    fn code(&self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ModalMaterial {
    Surface,
    Image,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ContentMessage {
    Appearance {
        theme: Theme,
        language: Language,
        material: Option<ModalMaterial>,
    },
    Header {
        slot: Option<[f64; 2]>,
    },
}

#[derive(Clone)]
enum WindowAction {
    Minimize,
    Maximize,
    Close,
}
#[derive(Clone)]
enum ServiceEvent {
    ResetWebsitePermissions(
        std::sync::Arc<
            std::sync::Mutex<Option<(String, oneshot::Sender<std::result::Result<(), String>>)>>,
        >,
    ),
    PageCommand(std::sync::Arc<std::sync::Mutex<Option<crate::app::page::Command>>>),
    PageMessage(uuid::Uuid, String),
    PageNavigate(uuid::Uuid),
    PagePopup(uuid::Uuid),
    Ready {
        entry: String,
        launcher: url::Url,
    },
    Navigate(String, bool),
    OverlayAvailable(String, u64),
    VoiceOverlay(popup::Overlay, String, u64),
    ContentLoading(WindowId, String),
    Mount(watch_mount::Request, String, u64),
    Finished,
    PopupClosed(WindowId),
    PopupLoaded(WindowId),
    PopupPresentation(WindowId, popup::Message),
    PopupAppearance(WindowId, Theme, Language, Option<ModalMaterial>),
    Reveal(reveal::Request, String, u64),
    Download(WindowId, String, download::Status),
    Permission,
    PermissionReady(WindowId),
    PermissionDecision(WindowId, bool),
    Fullscreen(bool),
    Caption(WindowId, WindowAction),
    CaptionReady(WindowId),
    OpenBookmarks(WindowId),
    PopupTitle(WindowId, String),
    Content(ContentMessage),
}

#[derive(Clone, Copy, Deserialize)]
struct WindowControls {
    width: f64,
    height: f64,
}
impl WindowControls {
    fn size(&self) -> LogicalSize<f64> {
        LogicalSize::new(self.width, self.height)
    }
}

struct Core {
    stop: Option<oneshot::Sender<()>>,
    worker: Option<thread::JoinHandle<Result<()>>>,
}

#[cfg(test)]
#[test]
fn worker_finishes_after_headless_close() -> Result<()> {
    use tao::platform::windows::EventLoopBuilderExtWindows;
    let directory = tempfile::tempdir()?;
    let config = Config {
        data_root: directory.path().into(),
        assets: directory.path().into(),
        open_browser: false,
        terminal_notice: None,
        page_player: None,
        website_permission_reset: None,
        window_navigation: None,
        cloudflared: Default::default(),
        ice_servers: vec![],
        update: Default::default(),
    };
    let mut events = EventLoopBuilder::with_user_event().with_any_thread(true).build();
    let mut core = Core::start(config, Some(0), events.create_proxy())?;
    let mut ready = false;
    let mut finished = false;
    events.run_return(|event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(ServiceEvent::Ready { .. }) => {
                ready = true;
                core.stop();
            }
            Event::UserEvent(ServiceEvent::Finished) => {
                finished = true;
                *flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
    core.finish()?;
    assert!(ready && finished);
    Ok(())
}
impl Core {
    fn start(
        config: Config,
        port: Option<u16>,
        events: EventLoopProxy<ServiceEvent>,
    ) -> Result<Self> {
        let (stop, stopped) = oneshot::channel();
        let worker = thread::Builder::new().name("piik-app".into()).spawn(move || {
            let completed = catch_unwind(AssertUnwindSafe(|| -> Result<()> {
                let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
                runtime.block_on(async {
                    let signal = piik_channel_native::shutdown_signal()?;
                    let listener = app::listen(port).await?;
                    let launcher = url::Url::parse(&format!("http://{}/client", listener.local_addr()?))?;
                    let (ready, entry) = oneshot::channel();
                    let service = app::serve(listener, config, async {
                        tokio::select! { _ = stopped => {}, _ = signal => {} }
                    }, Some(ready));
                    tokio::pin!(service);
                    tokio::select! {
                        result = &mut service => result,
                        entry = entry => {
                            if let Ok(entry) = entry { let _ = events.send_event(ServiceEvent::Ready { entry, launcher }); }
                            service.await
                        },
                    }
                })
            }));
            let result = match completed {
                Ok(result) => result,
                Err(_) => Err(anyhow::anyhow!("App service thread panicked")),
            };
            let _ = events.send_event(ServiceEvent::Finished);
            result
        })?;
        Ok(Self {
            stop: Some(stop),
            worker: Some(worker),
        })
    }
    fn stop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
    fn finish(mut self) -> Result<()> {
        self.stop();
        self.worker
            .take()
            .expect("App worker")
            .join()
            .map_err(|_| anyhow::anyhow!("App service thread panicked"))?
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        self.stop();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

// The App service selects the workspace origin. Page links cannot select another one.
#[derive(Clone, Default)]
struct WorkspaceOrigins {
    launcher: Option<url::Origin>,
    site: Option<url::Origin>,
    opening: Option<url::Origin>,
    local_room: Option<url::Origin>,
}
impl WorkspaceOrigins {
    // The launcher adds presentation and App affinity for a fresh document. Only
    // a room destination in the current verified workspace can keep that document.
    fn room_navigation(&self, current: &str, target: &str) -> Option<url::Url> {
        let mut current = url::Url::parse(current).ok()?;
        let target = url::Url::parse(target).ok()?;
        let route_query = |key: &str| !matches!(key, "piik-client-port" | "piik-preferences");
        if self.opening.is_some()
            || self.site.as_ref() != Some(&current.origin())
            || current.origin() != target.origin()
            || current.path() != target.path()
            || !current.query_pairs().filter(|(key, _)| route_query(key))
                .eq(target.query_pairs().filter(|(key, _)| route_query(key)))
        {
            return None;
        }
        let mut fragment = url::form_urlencoded::Serializer::new(String::new());
        let mut room = false;
        for (key, value) in url::form_urlencoded::parse(target.fragment()?.as_bytes()) {
            match key.as_ref() {
                "room" if !value.is_empty() => {
                    room = true;
                    fragment.append_pair(&key, &value);
                }
                "invite" => { fragment.append_pair(&key, &value); }
                "piik-client" | "piik-lang" | "piik-theme" => {}
                _ => return None,
            }
        }
        if !room {
            return None;
        }
        current.set_fragment(Some(&fragment.finish()));
        Some(current)
    }

    fn overlay_document(&self, address: &str) -> bool {
        url::Url::parse(address).is_ok_and(|url| {
            let origin = Some(url.origin());
            (origin == self.local_room || origin == self.launcher) && matches!(url.path(), "/" | "/index.html")
        })
    }
    fn handles(&self, address: &str, open_external: bool) -> bool {
        if address == "about:blank" {
            return true;
        }
        let Ok(url) = url::Url::parse(address) else { return false };
        let origin = url.origin();
        if matches!(url.scheme(), "http" | "https" | "blob")
            && (self.launcher.as_ref() == Some(&origin) || self.site.as_ref() == Some(&origin) || self.opening.as_ref() == Some(&origin))
        {
            return true;
        }
        if open_external && matches!(url.scheme(), "http" | "https") && url.username().is_empty() && url.password().is_none() {
            if let Err(error) = webbrowser::open(url.as_str()) {
                eprintln!("Open link in browser: {error}");
            }
        }
        false
    }
}

#[cfg(test)]
#[test]
fn workspace_room_navigation_ignores_launch_metadata_but_preserves_routing() {
    let current = "https://site.example/view?layout=screen&label=two+words#room=one";
    let mut origins = WorkspaceOrigins {
        site: Some(url::Url::parse(current).unwrap().origin()),
        ..WorkspaceOrigins::default()
    };
    let target = "https://site.example/view?layout=screen&label=two%20words&piik-client-port=19883&piik-preferences=theme#room=two&invite=key&piik-client=1&piik-theme=dark";
    assert_eq!(
        origins.room_navigation(current, target).unwrap().as_str(),
        "https://site.example/view?layout=screen&label=two+words#room=two&invite=key"
    );
    for target in [
        target.replace("site.example", "elsewhere.example"),
        target.replace("/view?", "/other?"),
        target.replace("layout=screen", "layout=room"),
        target.replace("#room=two", "&layout=room#room=two"),
        target.replace("room=two", "owner=key"),
        target.replace("piik-theme=dark", "owner=key"),
    ] {
        assert!(origins.room_navigation(current, &target).is_none());
    }
    origins.opening = origins.site.take();
    assert!(origins.room_navigation(current, target).is_none());
}

fn workspace_navigation(view: &WebView, origins: Rc<RefCell<WorkspaceOrigins>>) -> Result<()> {
    unsafe {
        view.webview().add_NavigationStarting(
            &webview2_com::NavigationStartingEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut uri = windows_core::PWSTR::null();
                args.Uri(&mut uri)?;
                let mut redirected = Default::default();
                args.IsRedirected(&mut redirected)?;
                let mut user_initiated = Default::default();
                args.IsUserInitiated(&mut user_initiated)?;
                let allowed = origins.borrow().handles(
                    &webview2_com::take_pwstr(uri), user_initiated.as_bool() && !redirected.as_bool(),
                );
                args.SetCancel(!allowed)
            })),
            &mut Default::default(),
        )?;
    }
    Ok(())
}

struct PopupWindow {
    overlay_document: Option<u64>,
    overlay_token: uuid::Uuid,
    panel_geometry: std::cell::Cell<Option<(LogicalSize<f64>, bool)>>,
    caption: caption::Caption,
    content: WebView,
    window: Rc<Window>,
}
impl PopupWindow {
    fn new(
        window: Rc<Window>,
        overlay_document: Option<u64>,
        environment: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment,
        events: EventLoopProxy<ServiceEvent>,
        pending: PendingPermissions,
        origins: Rc<RefCell<WorkspaceOrigins>>,
        controls: &WindowControls,
    ) -> Result<Self> {
        let id = window.id();
        let presentation = events.clone();
        let title_events = events.clone();
        let load_events = events.clone();
        let document = Rc::new(std::cell::Cell::new(0u64));
        let loading_document = document.clone();
        let token = uuid::Uuid::new_v4();
        let mut builder = WebViewBuilder::new();
        if overlay_document.is_some() {
            builder = builder.with_initialization_script_for_main_only(popup::overlay_script(token), true);
        }
        let webview = builder.with_environment(environment)
            .with_new_window_req_handler({
                let origins = origins.clone();
                move |url, _| {
                    origins.borrow().handles(&url, true);
                    NewWindowResponse::Deny
                }
            })
            .with_initialization_script(SYSTEM_PRESENTATION)
            .with_initialization_script(download::SCRIPT)
            .with_document_title_changed_handler(move |title| { let _ = title_events.send_event(ServiceEvent::PopupTitle(id, title)); })
            .with_on_page_load_handler(move |event, url| {
                if matches!(event, PageLoadEvent::Started) {
                    loading_document.set(loading_document.get().wrapping_add(1));
                    let _ = load_events.send_event(ServiceEvent::ContentLoading(id, url));
                } else {
                    let _ = load_events.send_event(ServiceEvent::PopupLoaded(id));
                }
            })
            .with_ipc_handler(move |request| {
                if let Ok(message) = serde_json::from_str::<popup::Message>(request.body()) {
                    let _ = presentation.send_event(ServiceEvent::PopupPresentation(id, message));
                } else if let Ok(ContentMessage::Appearance { theme, language, material }) = serde_json::from_str(request.body()) {
                    let _ = presentation.send_event(ServiceEvent::PopupAppearance(id, theme, language, material));
                }
            })
            .build_as_child(window.as_ref())?;
        let download_events = events.clone();
        workspace_navigation(&webview, origins)?;
        download::install(&webview, Some(Rc::new(move |url, status| {
            let _ = download_events.send_event(ServiceEvent::Download(id, url, status));
        })), None)?;
        let caption = caption::Caption::new(&window, &webview, events.clone(), controls, true)?;
        caption.title("Piik");
        caption.layout(&window, &webview, controls);
        permissions(&webview, id, document, pending, events.clone())?;
        let closed = events.clone();
        // The WebView closes its container; this adapter retires the top-level window.
        unsafe {
            webview.webview().add_WindowCloseRequested(
                &WindowCloseRequestedEventHandler::create(Box::new(move |_, _| {
                    let _ = closed.send_event(ServiceEvent::PopupClosed(id));
                    Ok(())
                })), &mut Default::default(),
            )?;
        }
        Ok(Self {
            overlay_document, overlay_token: token,
            panel_geometry: Default::default(), caption, content: webview, window,
        })
    }

    fn set_overlay_mode(&self, mode: popup::Mode, controls: &WindowControls) {
        let pinned = matches!(mode, popup::Mode::Pinned);
        if self.window.set_ignore_cursor_events(pinned).is_err() {
            return;
        }
        self.window.set_focusable(!pinned);
        if matches!(mode, popup::Mode::Panel) {
            if let Some((size, maximized)) = self.panel_geometry.take() {
                self.window.set_maximized(false);
                self.window.set_inner_size(size);
                self.window.set_maximized(maximized);
            }
        } else if self.panel_geometry.get().is_none() {
            let maximized = self.window.is_maximized();
            if maximized {
                self.window.set_maximized(false);
            }
            let size = self.window.inner_size().to_logical::<f64>(self.window.scale_factor());
            self.panel_geometry.set(Some((size, maximized)));
            self.window.set_inner_size(caption::window_size(LogicalSize::new(304., 216.), controls));
        }
        self.window.set_always_on_top(true);
        if matches!(mode, popup::Mode::Editing) {
            self.window.set_focus();
            let _ = self.content.focus();
        }
    }

    fn follow_main_appearance(&self, launcher: Option<&url::Url>, theme: &Theme, language: Language) {
        let Some(page) = self.content.url().ok().and_then(|url| url::Url::parse(&url).ok()) else {
            return;
        };
        if launcher.is_some_and(|url| url.origin() == page.origin())
            && page.path() == "/client"
            && page.query_pairs().any(|(key, _)| key == "bookmarks")
        {
            let origin = serde_json::json!(page.origin().ascii_serialization());
            let appearance = serde_json::json!({ "theme": theme.code(), "language": language.code() });
            let _ = self.content.evaluate_script(&format!(
                "if(location.origin==={origin}&&location.pathname==='/client'&&new URLSearchParams(location.search).has('bookmarks'))window.dispatchEvent(new CustomEvent('piik-window-appearance',{{detail:{appearance}}}));"
            ));
        } else if page.scheme() == "https"
            && page.host_str() == Some("piik.tv")
            && page.path().starts_with("/docs/")
        {
            self.caption.appearance(theme, language, None);
        }
    }
}
type Popups = Rc<RefCell<Vec<PopupWindow>>>;

// Fields drop in this order: both WebViews retire before their native owner.
struct MainWindow {
    origins: Rc<RefCell<WorkspaceOrigins>>,
    receipts: Rc<download::ReceiptBook>,
    document: Rc<std::cell::Cell<u64>>,
    caption: caption::Caption,
    content: WebView,
    window: Rc<Window>,
}
impl MainWindow {
    fn new(
        target: &EventLoopWindowTarget<ServiceEvent>,
        events: EventLoopProxy<ServiceEvent>,
        context: &mut WebContext,
        receipts: Rc<download::ReceiptBook>,
        pending: PendingPermissions,
        popups: Popups,
        controls: &WindowControls,
    ) -> Result<Self> {
        let window = Rc::new(
            window_builder()?
                .with_title("Piik")
                .with_decorations(false)
                .with_undecorated_shadow(true)
                .with_inner_size(LogicalSize::new(1120.0, 760.0))
                .with_visible(false)
                .build(target)?,
        );
        set_minimum_client_size(&window);
        let id = window.id();
        let popup_controls = *controls;
        let popup_target = target.clone();
        let popup_events = events.clone();
        let popup_pending = pending.clone();
        let content_events = events.clone();
        let load_events = events.clone();
        let document = Rc::new(std::cell::Cell::new(0u64));
        let loading_document = document.clone();
        let ipc_document = document.clone();
        let origins = Rc::new(RefCell::new(WorkspaceOrigins::default()));
        let popup_origins = origins.clone();
        let opener_generation = document.clone();
        let content = WebViewBuilder::new_with_web_context(context).with_url("about:blank")
            .with_initialization_script(CAPABILITY)
            .with_initialization_script(reveal::SCRIPT)
            .with_initialization_script_for_main_only(watch_mount::SCRIPT, true)
            .with_initialization_script(download::SCRIPT)
            .with_on_page_load_handler(move |event, url| {
                // Wry maps Started to top-level ContentLoading, after cancellation is resolved.
                if matches!(event, PageLoadEvent::Started) {
                    loading_document.set(loading_document.get().wrapping_add(1));
                    let _ = load_events.send_event(ServiceEvent::ContentLoading(id, url));
                } else {
                    let _ = load_events.send_event(ServiceEvent::OverlayAvailable(url, loading_document.get()));
                }
            })
            .with_ipc_handler(move |request| {
                if let Ok(message) = serde_json::from_str::<popup::Overlay>(request.body()) {
                    let _ = content_events.send_event(ServiceEvent::VoiceOverlay(message, request.uri().to_string(), ipc_document.get()));
                    return;
                }
                if let Ok(request_body) = serde_json::from_str::<watch_mount::Request>(request.body()) {
                    let _ = content_events.send_event(ServiceEvent::Mount(request_body, request.uri().to_string(), ipc_document.get()));
                    return;
                }
                if let Ok(message) = serde_json::from_str::<reveal::Request>(request.body()) {
                    let _ = content_events.send_event(ServiceEvent::Reveal(message, request.uri().to_string(), ipc_document.get()));
                    return;
                }
                if let Ok(message) = serde_json::from_str::<ContentMessage>(request.body()) {
                    if matches!(&message, ContentMessage::Header { slot: Some([x, y]) } if !x.is_finite() || !y.is_finite()) { return; }
                    let _ = content_events.send_event(ServiceEvent::Content(message));
                }
            })
            .with_new_window_req_handler(move |url, features| {
                if !popup_origins.borrow().handles(&url, true) { return NewWindowResponse::Deny; }
                let create = || -> Result<NewWindowResponse> {
                    let window = Rc::new(popup::builder(window_builder()?, features.size, features.position, &popup_controls)
                        .with_decorations(false).with_undecorated_shadow(true).build(&popup_target)?);
                    let mut opener = windows_core::PWSTR::null();
                    unsafe { features.opener.webview.Source(&mut opener)?; }
                    let address = webview2_com::take_pwstr(opener);
                    let overlay_document = (url == "about:blank" && popup_origins.borrow().overlay_document(&address))
                        .then(|| opener_generation.get());
                    let popup = PopupWindow::new(window, overlay_document, features.opener.environment, popup_events.clone(),
                        popup_pending.clone(), popup_origins.clone(), &popup_controls)?;
                    let response = NewWindowResponse::Create { webview: popup.content.webview() };
                    popups.borrow_mut().push(popup);
                    Ok(response)
                };
                create().unwrap_or_else(|error| {
                    eprintln!("Open Piik window: {error:#}");
                    NewWindowResponse::Deny
                })
            })
            .with_bounds(wry::Rect { position: LogicalPosition::new(0.0, 0.0).into(), size: window.inner_size().into() })
            .build_as_child(window.as_ref())?;
        let download_events = events.clone();
        workspace_navigation(&content, origins.clone())?;
        download::install(&content, Some(Rc::new(move |url, status| {
            let _ = download_events.send_event(ServiceEvent::Download(id, url, status));
        })), Some(receipts.clone()))?;
        permissions(&content, id, document.clone(), pending, events.clone())?;
        let fullscreen_events = events.clone();
        unsafe {
            content.webview().add_ContainsFullScreenElementChanged(
                &ContainsFullScreenElementChangedEventHandler::create(Box::new(
                    move |sender, _| {
                        if let Some(sender) = sender {
                            let mut active = Default::default();
                            sender.ContainsFullScreenElement(&mut active)?;
                            let _ = fullscreen_events
                                .send_event(ServiceEvent::Fullscreen(active.as_bool()));
                        }
                        Ok(())
                    },
                )),
                &mut Default::default(),
            )?;
        }

        let caption = caption::Caption::new(&window, &content, events, controls, false)?;
        let result = Self {
            receipts, document, origins,
            caption,
            content,
            window,
        };
        result.position_caption(controls, None);
        Ok(result)
    }

    fn position_caption(&self, controls: &WindowControls, slot: Option<[f64; 2]>) {
        let size = self
            .window
            .inner_size()
            .to_logical::<f64>(self.window.scale_factor());
        // Loading and the runtime's network-error page have no shared header.
        // Keep window controls reachable there without introducing another band.
        let [x, y] = slot.unwrap_or([size.width - controls.width, 0.0]);
        let _ = self.caption.view.set_bounds(wry::Rect {
            position: LogicalPosition::new(
                x.clamp(0.0, (size.width - controls.width).max(0.0)),
                y.clamp(0.0, (size.height - controls.height).max(0.0)),
            )
            .into(),
            size: controls.size().into(),
        });
        let _ = self.caption.view.set_visible(self.window.fullscreen().is_none());
    }
}

fn set_minimum_client_size(window: &Window) {
    let outer = window.outer_size();
    let inner = window.inner_size();
    let minimum = LogicalSize::new(520.0, 360.0).to_physical::<u32>(window.scale_factor());
    // Tao 0.37 removes border styles from undecorated minimum constraints, but
    // its shadow retains a frame inset. Use GetWindowRect/GetClientRect-backed
    // sizes so this constraint describes usable content at the current DPI.
    window.set_min_inner_size(Some(PhysicalSize::new(
        minimum.width + outer.width.saturating_sub(inner.width),
        minimum.height + outer.height.saturating_sub(inner.height),
    )));
}

fn message_box(owner: isize, text: &str, flags: u32) -> i32 {
    let text: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    let caption: Vec<u16> = "Piik".encode_utf16().chain(Some(0)).collect();
    // SAFETY: Both terminated strings remain live for the synchronous native dialog.
    unsafe { MessageBoxW(owner, text.as_ptr(), caption.as_ptr(), flags) }
}

pub fn report_error(detail: &str) {
    if !console::shared() {
        message_box(0, detail, 0x10);
    }
}

pub fn run(mut config: Config, port: Option<u16>) -> Result<()> {
    config.open_browser = false;
    let controls: WindowControls =
        serde_json::from_str(CONTROLS).context("Read window controls")?;
    let mut events = EventLoopBuilder::<ServiceEvent>::with_user_event().build();
    let pending: PendingPermissions = Rc::default();
    let popups: Popups = Rc::default();
    let mut context = WebContext::new(Some(config.data_root.join("webview")));
    let mut pages = page::Pages::new(config.data_root.join("web-player"));
    let window = match MainWindow::new(
        &events,
        events.create_proxy(),
        &mut context,
        Rc::new(download::ReceiptBook::new(config.data_root.join("download-receipts"))),
        pending.clone(),
        popups.clone(),
        &controls,
    ) {
        Ok(window) => Some(window),
        Err(error) => {
            attach_console(true).context("Open the fallback App terminal")?;
            config.terminal_notice = Some(format!("System WebView unavailable: {error:#}"));
            config.open_browser = true;
            None
        }
    };
    let permission_profile = window
        .as_ref()
        .and_then(|main| permission::profile(&main.content).ok());
    let permission_reset_events = events.create_proxy();
    config.website_permission_reset = permission_profile.as_ref().map(|_| {
        std::sync::Arc::new(move |site, reply| {
            permission_reset_events
                .send_event(ServiceEvent::ResetWebsitePermissions(std::sync::Arc::new(
                    std::sync::Mutex::new(Some((site, reply))),
                )))
                .is_ok()
        }) as app::WebsitePermissionReset
    });
    let navigation = events.create_proxy();
    config.window_navigation = window.as_ref().map(|_| {
        app::WindowNavigation::new(move |url, local| {
            navigation.send_event(ServiceEvent::Navigate(url, local)).is_ok()
        })
    });
    let page_events = events.create_proxy();
    config.page_player = window.as_ref().map(|_| {
        std::sync::Arc::new(move |command| {
            page_events
                .send_event(ServiceEvent::PageCommand(std::sync::Arc::new(
                    std::sync::Mutex::new(Some(command)),
                )))
                .is_ok()
        }) as crate::app::page::Dispatcher
    });
    let mut core = Core::start(config, port, events.create_proxy())?;
    let mut result = Ok(());
    let mut language = Language::En;
    let mut theme = Theme::Light;
    let mut launcher_url: Option<url::Url> = None;
    let mut bookmarks_window = None;
    let mut prompt: Option<Prompt> = None;
    let mut slot = None;
    let mut minimum_scale = window.as_ref().map(|main| main.window.scale_factor());
    let permission_events = events.create_proxy();
    let page_events = events.create_proxy();
    events.run_return(|event, target, flow| {
        *flow = ControlFlow::Wait;
        let present_permission = matches!(&event, Event::UserEvent(ServiceEvent::Permission));
        let had_prompt = prompt.is_some();
        match event {
            Event::UserEvent(ServiceEvent::Reveal(request, source, generation)) => {
                if let Some(main) = &window {
                    if let Some(confirm) = reveal::Confirmation::prepare(main, request, &source, generation) {
                        if prompt.is_some() {
                            confirm.answer(main, false);
                        } else {
                            let next = Prompt::new(target, permission_events.clone(), &mut context, permission::Action::Reveal(confirm.clone()), main.window.clone(), &theme, language);
                            match next {
                                Ok(next) => prompt = Some(next),
                                Err(_) => confirm.answer(main, false),
                            }
                        }
                    }
                }
            }
            Event::UserEvent(ServiceEvent::Download(id, url, status)) => {
                if let Some(main) = window.as_ref().filter(|main| main.window.id() == id) {
                    download::report(&main.content, &url, status);
                } else if let Some(child) = popups.borrow().iter().find(|child| child.window.id() == id) {
                    download::report(&child.content, &url, status);
                }
            }
            Event::UserEvent(ServiceEvent::Content(ContentMessage::Appearance {
                theme: next_theme,
                language: next,
                material,
            })) => {
                language = next;
                theme = next_theme;
                if let Some(main) = &window {
                    main.caption.appearance(&theme, language, material);
                }
                pages.appearance(&theme, language);
                for child in popups.borrow().iter() {
                    child.follow_main_appearance(launcher_url.as_ref(), &theme, language);
                }
                if let Some(prompt) = &prompt {
                    prompt.update_appearance(&theme, language);
                }
            }
            Event::UserEvent(ServiceEvent::Mount(request, source, generation)) => {
                if let Some(main) = &window { request.apply(main, &mut pages, &source, generation); }
            }
            Event::UserEvent(ServiceEvent::ContentLoading(id, url)) => {
                if prompt.as_ref().is_some_and(Prompt::media_is_stale) {
                    prompt.take();
                }
                permission::retire_pending(&pending, |request| !request.is_current());
                if let Some(main) = window.as_ref().filter(|main| main.window.id() == id) {
                    pages.release_mounts();
                    if prompt.as_ref().is_some_and(|dialog| dialog.stale(main)) { prompt.take(); }
                    let origin = url::Url::parse(&url).ok().map(|page| page.origin());
                    let mut origins = main.origins.borrow_mut();
                    let switch_site = origins.opening.is_some() && origins.opening == origin;
                    if switch_site {
                        origins.site = origins.opening.take();
                        slot = None;
                        main.window.set_fullscreen(None);
                        main.position_caption(&controls, None);
                    }
                    drop(origins);
                    let retires = |id| popups.borrow().iter().any(|child| {
                        child.window.id() == id && (switch_site || child.panel_geometry.get().is_some())
                    });
                    if prompt.as_ref().is_some_and(|dialog| retires(dialog.owner())) {
                        prompt.take();
                    }
                    permission::retire_pending(&pending, |request| retires(request.owner));
                    popups.borrow_mut().retain(|child| !switch_site && child.panel_geometry.get().is_none());
                    main.caption.content_loading();
                }
            }
            Event::UserEvent(ServiceEvent::ResetWebsitePermissions(command)) => {
                if let Some((site, reply)) = command.lock().unwrap().take() {
                    if let Some(profile) = &permission_profile {
                        permission::reset(profile, &site, reply);
                    } else {
                        let _ = reply.send(Err("Website permission reset is unavailable".into()));
                    }
                }
            }
            Event::UserEvent(ServiceEvent::PageCommand(command)) => {
                if let Some(command) = command.lock().unwrap().take() {
                    pages.command(command, target, page_events.clone());
                }
            }
            Event::UserEvent(ServiceEvent::PageMessage(id, body)) => pages.message(id, &body),
            Event::UserEvent(ServiceEvent::PageNavigate(id)) => pages.navigate(id),
            Event::UserEvent(ServiceEvent::PagePopup(id)) => {
                pages.popup(id, target, page_events.clone())
            }
            Event::UserEvent(ServiceEvent::Content(ContentMessage::Header { slot: next })) => {
                slot = next;
                if let Some(main) = &window {
                    main.position_caption(&controls, slot);
                }
            }
            Event::UserEvent(ServiceEvent::Caption(id, action)) => {
                if matches!(action, WindowAction::Close) {
                    if window.as_ref().is_some_and(|main| main.window.id() == id) { core.stop(); }
                    else { let _ = permission_events.send_event(ServiceEvent::PopupClosed(id)); }
                } else if let Some(main) = window.as_ref().filter(|main| main.window.id() == id) {
                    caption::apply(&main.window, &action);
                } else if let Some(child) = popups.borrow().iter().find(|child| child.window.id() == id) {
                    caption::apply(&child.window, &action);
                } else { pages.window_action(id, &action); }
            }
            Event::UserEvent(ServiceEvent::CaptionReady(id)) => {
                if let Some(main) = window.as_ref().filter(|main| main.window.id() == id) { main.caption.ready(&theme, language); }
                else if let Some(child) = popups.borrow().iter().find(|child| child.window.id() == id) {
                    child.caption.ready(&theme, language);
                    child.caption.layout(&child.window, &child.content, &controls);
                } else { pages.caption_ready(id, &theme, language, &controls); }
            }
            Event::UserEvent(ServiceEvent::PopupTitle(id, title)) => {
                if let Some(child) = popups.borrow().iter().find(|child| child.window.id() == id) {
                    child.window.set_title(&title); child.caption.title(&title);
                }
            }
            Event::WindowEvent {
                event: WindowEvent::Resized(_),
                window_id,
                ..
            } if window
                .as_ref()
                .is_some_and(|main| main.window.id() == window_id) =>
            {
                let main = window.as_ref().unwrap();
                let owner = &main.window;
                if !owner.is_maximized()
                    && !owner.is_minimized()
                    && owner.fullscreen().is_none()
                    && minimum_scale != Some(owner.scale_factor())
                {
                    minimum_scale = Some(owner.scale_factor());
                    set_minimum_client_size(owner);
                }
                let _ = main.content.set_bounds(wry::Rect {
                    position: LogicalPosition::new(0.0, 0.0).into(),
                    size: owner.inner_size().into(),
                });
                main.position_caption(&controls, slot);
                let _ = main
                    .caption.view
                    .evaluate_script(&format!("window.updateMaximized({})", owner.is_maximized()));
            }
            Event::WindowEvent { event: WindowEvent::Resized(_), window_id, .. } => {
                if let Some(child) = popups.borrow().iter().find(|child| child.window.id() == window_id) {
                    child.caption.layout(&child.window, &child.content, &controls);
                } else { pages.resize(window_id, &controls); }
            }
            Event::UserEvent(ServiceEvent::Fullscreen(active)) => {
                if let Some(main) = &window {
                    main.window.set_fullscreen(
                        active.then(|| Fullscreen::Borderless(main.window.current_monitor())),
                    );
                    main.position_caption(&controls, slot);
                }
            }
            Event::UserEvent(ServiceEvent::PermissionReady(id)) => {
                if prompt.as_ref().is_some_and(Prompt::media_is_stale) {
                    prompt.take();
                }
                if let Some(prompt) = prompt.as_ref().filter(|prompt| prompt.id() == id) {
                    prompt.update_appearance(&theme, language);
                    prompt.show();
                }
            }
            Event::UserEvent(ServiceEvent::PermissionDecision(id, allowed)) => {
                if prompt.as_ref().is_some_and(|prompt| prompt.id() == id) {
                    let current = prompt.take().unwrap();
                    let owner = current.owner();
                    current.answer(allowed, window.as_ref(), &pending);
                    if let Some(main) = window.as_ref().filter(|main| main.window.id() == owner) {
                        let _ = main.content.focus();
                    } else if let Some(child) = popups
                        .borrow()
                        .iter()
                        .find(|child| child.window.id() == owner)
                    {
                        let _ = child.content.focus();
                    }
                }
            }
            Event::UserEvent(ServiceEvent::OpenBookmarks(id)) => {
                if let (Some(main), Some(launcher)) = (window.as_ref().filter(|main| main.window.id() == id), launcher_url.as_ref()) {
                    let result = (|| -> Result<()> {
                        let mut launcher = launcher.clone();
                        if let Some(open) = popups.borrow().iter().find(|popup| Some(popup.window.id()) == bookmarks_window) {
                            open.window.set_focus();
                            return Ok(());
                        }
                        launcher.query_pairs_mut().append_pair("bookmarks", "1");
                        let mut fragment = url::form_urlencoded::Serializer::new(String::new());
                        fragment.append_pair("piik-client", "1");
                        if let Some(site) = main.content.url().ok().and_then(|url| url::Url::parse(&url).ok())
                            .filter(|url| matches!(url.scheme(), "http" | "https") && url.origin() != launcher.origin())
                        {
                            fragment.append_pair("site", &site.origin().ascii_serialization());
                        }
                        launcher.set_fragment(Some(&fragment.finish()));
                        let window = Rc::new(popup::builder(window_builder()?, None, None, &controls)
                            .with_decorations(false).with_undecorated_shadow(true).build(target)?);
                        let popup = PopupWindow::new(window, None, main.content.environment(), page_events.clone(), pending.clone(), main.origins.clone(), &controls)?;
                        popup.content.load_url(launcher.as_str())?;
                        bookmarks_window = Some(popup.window.id());
                        popups.borrow_mut().push(popup);
                        Ok(())
                    })();
                    if let Err(error) = result {
                        eprintln!("Open saved sites: {error:#}");
                    }
                }
            }
            Event::UserEvent(ServiceEvent::Navigate(url, local)) => {
                if let Some(main) = &window {
                    let current = main.content.url().ok();
                    let room = current.as_ref().and_then(|current| {
                        main.origins.borrow().room_navigation(current, &url)
                    });
                    let result = if let Some(room) = &room {
                        if current.as_deref() == Some(room.as_str()) { Ok(()) }
                        else { main.content.load_url(room.as_str()) }
                    } else {
                        let origin = url::Url::parse(&url).ok().map(|u| u.origin());
                        main.origins.borrow_mut().local_room = local.then(|| origin.clone()).flatten();
                        main.origins.borrow_mut().opening = origin;
                        main.content.load_url(&url)
                    };
                    match result {
                        Ok(()) => {
                            main.window.set_minimized(false);
                            main.window.set_focus();
                        }
                        Err(error) => {
                            if room.is_none() { main.origins.borrow_mut().opening.take(); }
                            eprintln!("Open site in Piik: {error:#}");
                        }
                    }
                }
            }
            Event::UserEvent(ServiceEvent::OverlayAvailable(address, generation)) => {
                if let Some(main) = &window {
                    if generation == main.document.get() && main.origins.borrow().overlay_document(&address)
                        && main.content.url().ok().is_some_and(|url| main.origins.borrow().overlay_document(&url))
                    {
                        let url = url::Url::parse(&address).expect("eligible room URL");
                        let origin = serde_json::json!(url.origin().ascii_serialization());
                        let path = serde_json::json!(url.path());
                        let _ = main.content.evaluate_script(&format!(
                            "if(location.origin==={origin}&&location.pathname==={path}){{window.piikVoiceOverlay=true;dispatchEvent(new Event('piik-overlay-available'))}}"
                        ));
                    }
                }
            }
            Event::UserEvent(ServiceEvent::VoiceOverlay(message, source, generation)) => {
                let Some(main) = &window else { return };
                let children = popups.borrow();
                let Some(child) = children.iter().find(|child| child.overlay_token == message.token) else { return };
                let mode = message.voice_overlay;
                if generation != main.document.get() || !main.origins.borrow().overlay_document(&source) { return; }
                if child.overlay_document != Some(main.document.get()) || !main.content.url().ok().is_some_and(|url| main.origins.borrow().overlay_document(&url))
                    || child.content.url().ok().as_deref() != Some("about:blank") { return; }
                child.set_overlay_mode(mode, &controls);
            }
            Event::UserEvent(ServiceEvent::PopupPresentation(id, message)) => {
                if let Some(size) = message.panel_size() {
                    if let Some(child) = popups.borrow().iter().find(|child| child.window.id() == id) {
                        child.caption.set_panel();
                        if child.panel_geometry.get().is_some() { return; }
                        child.window.set_always_on_top(true);
                        child.window.set_inner_size(caption::window_size(size, &controls));
                    }
                }
            }
            Event::UserEvent(ServiceEvent::PopupAppearance(id, theme, language, material)) => {
                if let Some(child) = popups.borrow().iter().find(|child| child.window.id() == id) {
                    child.caption.appearance(&theme, language, material);
                    child.window.set_theme(Some(match theme {
                        Theme::Light => tao::window::Theme::Light,
                        Theme::Dark => tao::window::Theme::Dark,
                    }));
                }
            }
            Event::UserEvent(ServiceEvent::PopupLoaded(id)) => {
                if let Some(child) = popups.borrow().iter().find(|child| child.window.id() == id) {
                    child.follow_main_appearance(launcher_url.as_ref(), &theme, language);
                }
            }
            Event::UserEvent(ServiceEvent::Ready { entry, launcher }) => {
                if let Some(main) = &window {
                    let site = url::Url::parse(&entry).ok().map(|u| u.origin());
                    *main.origins.borrow_mut() = WorkspaceOrigins { launcher: Some(launcher.origin()), site, opening: None, local_room: None };
                }
                launcher_url = Some(launcher);
                let opened = match &window {
                    Some(main) => main.content.load_url(&entry).map_err(anyhow::Error::from),
                    None => Ok(()),
                };
                if let Err(error) = opened {
                    result = Err(error);
                    core.stop();
                } else if let Some(main) = &window {
                    main.window.set_visible(true);
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                window_id,
                ..
            }
            | Event::UserEvent(ServiceEvent::PopupClosed(window_id)) => {
                if pages.close_window(window_id) {
                } else if prompt
                    .as_ref()
                    .is_some_and(|prompt| prompt.id() == window_id)
                {
                    let _ = permission_events
                        .send_event(ServiceEvent::PermissionDecision(window_id, false));
                } else if window
                    .as_ref()
                    .is_some_and(|main| main.window.id() == window_id)
                {
                    core.stop();
                } else {
                    if prompt
                        .as_ref()
                        .is_some_and(|prompt| prompt.owner() == window_id)
                    {
                        prompt.take();
                    }
                    permission::retire_pending(&pending, |request| request.owner == window_id);
                    popups
                        .borrow_mut()
                        .retain(|child| child.window.id() != window_id);
                }
            }
            Event::UserEvent(ServiceEvent::Finished) => {
                core.stop();
                *flow = ControlFlow::Exit;
            }
            _ => {}
        }
        if core.stop.is_none() {
            prompt.take();
            pending.borrow_mut().clear();
        } else {
            // Building a WebView during the previous decision can stall its controller creation.
            if had_prompt && prompt.is_none() && !pending.borrow().is_empty() {
                let _ = permission_events.send_event(ServiceEvent::Permission);
            }
            while present_permission && prompt.is_none() {
                let Some(request) = pending.borrow_mut().pop_front() else {
                    break;
                };
                if !request.is_current() {
                    continue;
                }
                let owner = window
                    .as_ref()
                    .filter(|main| main.window.id() == request.owner)
                    .map(|main| main.window.clone())
                    .or_else(|| {
                        popups
                            .borrow()
                            .iter()
                            .find(|child| child.window.id() == request.owner)
                            .map(|child| child.window.clone())
                    });
                if let Some(owner) = owner {
                    match Prompt::new(
                        target,
                        permission_events.clone(),
                        &mut context,
                        permission::Action::Media(request),
                        owner,
                        &theme,
                        language,
                    ) {
                        Ok(next) => prompt = Some(next),
                        Err(error) => eprintln!("Open Piik permission window: {error:#}"),
                    }
                }
            }
        }
    });
    pages.clear();
    drop(prompt);
    pending.borrow_mut().clear();
    popups.borrow_mut().clear();
    result = result.and(core.finish());
    drop(window);
    result
}
