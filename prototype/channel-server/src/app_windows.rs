//! Windows owns presentation; the existing HTTP App owns all room and capture work.
mod console;
mod caption;
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
    NewWindowResponse, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows,
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
    },
    Navigate(String),
    Finished,
    PopupClosed(WindowId),
    PopupPresentation(WindowId, popup::Message),
    PopupAppearance(WindowId, Theme, Language, Option<ModalMaterial>),
    Download(WindowId, String, download::Status),
    Permission,
    PermissionReady(WindowId),
    PermissionDecision(WindowId, bool),
    Fullscreen(bool),
    Caption(WindowId, WindowAction),
    CaptionReady(WindowId),
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
                    let (ready, entry) = oneshot::channel();
                    let service = app::serve(listener, config, async {
                        tokio::select! { _ = stopped => {}, _ = signal => {} }
                    }, Some(ready));
                    tokio::pin!(service);
                    tokio::select! {
                        result = &mut service => result,
                        entry = entry => {
                            if let Ok(entry) = entry { let _ = events.send_event(ServiceEvent::Ready { entry }); }
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

struct PopupWindow {
    caption: caption::Caption,
    content: WebView,
    window: Rc<Window>,
}
type Popups = Rc<RefCell<Vec<PopupWindow>>>;

// Fields drop in this order: both WebViews retire before their native owner.
struct MainWindow {
    caption: caption::Caption,
    content: WebView,
    window: Rc<Window>,
}
impl MainWindow {
    fn new(
        target: &EventLoopWindowTarget<ServiceEvent>,
        events: EventLoopProxy<ServiceEvent>,
        context: &mut WebContext,
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
        let popup_controls = *controls;
        let popup_target = target.clone();
        let popup_events = events.clone();
        let popup_pending = pending.clone();
        let content_events = events.clone();
        let content = WebViewBuilder::new_with_web_context(context).with_url("about:blank")
            .with_initialization_script(CAPABILITY)
            .with_initialization_script(download::SCRIPT)
            .with_ipc_handler(move |request| {
                if let Ok(message) = serde_json::from_str::<ContentMessage>(request.body()) {
                    if matches!(&message, ContentMessage::Header { slot: Some([x, y]) } if !x.is_finite() || !y.is_finite()) { return; }
                    let _ = content_events.send_event(ServiceEvent::Content(message));
                }
            })
            .with_new_window_req_handler(move |_, features| {
                let create = || -> Result<NewWindowResponse> {
                    let window = Rc::new(popup::builder(window_builder()?, features.size, features.position, &popup_controls)
                        .with_decorations(false).with_undecorated_shadow(true).build(&popup_target)?);
                    let id = window.id();
                    let presentation = popup_events.clone();
                    let title_events = popup_events.clone();
                    let webview = WebViewBuilder::new()
                        .with_environment(features.opener.environment)
                        .with_initialization_script(SYSTEM_PRESENTATION)
                        .with_initialization_script(download::SCRIPT)
                        .with_document_title_changed_handler(move |title| { let _ = title_events.send_event(ServiceEvent::PopupTitle(id, title)); })
                        .with_ipc_handler(move |request| {
                            if let Ok(message) = serde_json::from_str::<popup::Message>(request.body()) {
                                let _ = presentation.send_event(ServiceEvent::PopupPresentation(id, message));
                            } else if let Ok(ContentMessage::Appearance { theme, language, material }) = serde_json::from_str(request.body()) {
                                let _ = presentation.send_event(ServiceEvent::PopupAppearance(id, theme, language, material));
                            }
                        })
                        .build_as_child(window.as_ref())?;
                    let download_events = popup_events.clone();
                    download::install(&webview, Some(Rc::new(move |url, status| {
                        let _ = download_events.send_event(ServiceEvent::Download(id, url, status));
                    })))?;
                    let caption = caption::Caption::new(&window, &webview, popup_events.clone(), &popup_controls, true)?;
                    caption.title("Piik");
                    caption.layout(&window, &webview, &popup_controls);
                    permissions(&webview, id, popup_pending.clone(), popup_events.clone())?;
                    let closed = popup_events.clone();
                    // The WebView closes its container; this adapter retires the top-level window.
                    unsafe {
                        webview.webview().add_WindowCloseRequested(
                            &WindowCloseRequestedEventHandler::create(Box::new(move |_, _| {
                                let _ = closed.send_event(ServiceEvent::PopupClosed(id));
                                Ok(())
                            })), &mut Default::default(),
                        )?;
                    }
                    let response = NewWindowResponse::Create { webview: webview.webview() };
                    popups.borrow_mut().push(PopupWindow { caption, content: webview, window });
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
        let id = window.id();
        download::install(&content, Some(Rc::new(move |url, status| {
            let _ = download_events.send_event(ServiceEvent::Download(id, url, status));
        })))?;
        permissions(&content, window.id(), pending, events.clone())?;
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
    if !console::attached() {
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
        std::sync::Arc::new(move |url: String| {
            navigation.send_event(ServiceEvent::Navigate(url)).is_ok()
        }) as std::sync::Arc<dyn Fn(String) -> bool + Send + Sync>
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
    let mut prompt: Option<Prompt> = None;
    let mut slot = None;
    let mut minimum_scale = window.as_ref().map(|main| main.window.scale_factor());
    let permission_events = events.create_proxy();
    let page_events = events.create_proxy();
    events.run_return(|event, target, flow| {
        *flow = ControlFlow::Wait;
        match event {
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
                if let Some(prompt) = &prompt {
                    prompt.update_appearance(&theme, language);
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
                    child.caption.title(&child.window.title());
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
                if let Some(prompt) = prompt.as_ref().filter(|prompt| prompt.id() == id) {
                    prompt.update_appearance(&theme, language);
                    prompt.show();
                }
            }
            Event::UserEvent(ServiceEvent::PermissionDecision(id, allowed)) => {
                if prompt.as_ref().is_some_and(|prompt| prompt.id() == id) {
                    let current = prompt.take().unwrap();
                    let owner = current.owner();
                    current.answer(allowed);
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
            Event::UserEvent(ServiceEvent::Navigate(url)) => {
                if let Some(main) = &window {
                    match main.content.load_url(&url) {
                        Ok(()) => {
                            // Navigation retires the old page's surfaces and permission requests;
                            // its App-hosted rooms remain with the service.
                            prompt.take();
                            pending.borrow_mut().clear();
                            popups.borrow_mut().clear();
                            slot = None;
                            main.window.set_fullscreen(None);
                            main.position_caption(&controls, None);
                            main.window.set_minimized(false);
                            main.window.set_focus();
                        }
                        Err(error) => eprintln!("Open site in Piik: {error:#}"),
                    }
                }
            }
            Event::UserEvent(ServiceEvent::PopupPresentation(id, message)) => {
                if let Some(size) = message.panel_size() {
                    if let Some(child) = popups.borrow().iter().find(|child| child.window.id() == id) {
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
            Event::UserEvent(ServiceEvent::Ready { entry }) => {
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
                    pending
                        .borrow_mut()
                        .retain(|request| request.owner != window_id);
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
            while prompt.is_none() {
                let Some(request) = pending.borrow_mut().pop_front() else {
                    break;
                };
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
                        request,
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
