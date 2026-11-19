//! A trusted, owner-bound prompt holds each deferred camera or microphone request.
use super::{window_builder, Language, ServiceEvent, Theme, CONTROLS, PALETTE};
use anyhow::Result;
use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    rc::Rc,
};
use tao::{
    dpi::{LogicalSize, PhysicalPosition},
    event_loop::{EventLoopProxy, EventLoopWindowTarget},
    platform::windows::{WindowBuilderExtWindows, WindowExtWindows},
    window::{Window, WindowId},
};
use tokio::sync::oneshot;
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Deferral, ICoreWebView2PermissionRequestedEventArgs3, ICoreWebView2Profile4,
        ICoreWebView2_13, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        COREWEBVIEW2_PERMISSION_STATE_DEFAULT, COREWEBVIEW2_PERMISSION_STATE_DENY,
    },
    PermissionRequestedEventHandler, SetPermissionStateCompletedHandler,
};
use windows_core::{Interface, PCWSTR};
use wry::{
    NewWindowResponse, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows,
    WebViewExtWindows,
};

const DOCUMENT: &str = include_str!("../../../../src/client/ui/native-permission.html");
const BRAND_MARK: &str = include_str!("../../../../public/favicon.svg");
const BUTTONS: &str = include_str!("../../../../src/client/components/living/button.css");
const PANEL: &str =
    include_str!("../../../../src/client/channel/components/channel-settings-dialog.css");

// The platform profile is the only saved website-grant store.
pub(super) fn profile(view: &WebView) -> Result<ICoreWebView2Profile4> {
    unsafe {
        Ok(view
            .webview()
            .cast::<ICoreWebView2_13>()?
            .Profile()?
            .cast()?)
    }
}

pub(super) fn reset(
    profile: &ICoreWebView2Profile4,
    origin: &str,
    reply: oneshot::Sender<std::result::Result<(), String>>,
) {
    let kinds = [
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_KIND_CAMERA,
    ];
    let remaining = Rc::new(Cell::new(kinds.len()));
    let result = Rc::new(RefCell::new((None::<String>, Some(reply))));
    let complete = Rc::new(move |error: Option<String>| {
        let mut result = result.borrow_mut();
        if result.0.is_none() {
            result.0 = error;
        }
        remaining.set(remaining.get() - 1);
        if remaining.get() == 0 {
            let value = result.0.take().map_or(Ok(()), Err);
            if let Some(reply) = result.1.take() {
                let _ = reply.send(value);
            }
        }
    });
    let origin: Vec<u16> = origin.encode_utf16().chain(Some(0)).collect();
    for kind in kinds {
        let completed = complete.clone();
        let handler = SetPermissionStateCompletedHandler::create(Box::new(move |status| {
            completed(status.err().map(|error| error.to_string()));
            Ok(())
        }));
        let started = unsafe {
            profile.SetPermissionState(
                kind,
                PCWSTR(origin.as_ptr()),
                COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
                &handler,
            )
        };
        if let Err(error) = started {
            complete(Some(error.to_string()));
        }
    }
}

pub(super) struct Permission {
    pub(super) owner: WindowId,
    args: ICoreWebView2PermissionRequestedEventArgs3,
    deferral: Option<ICoreWebView2Deferral>,
    origin: String,
    camera: bool,
}
impl Permission {
    fn complete(&mut self, allowed: bool) {
        if let Some(deferral) = self.deferral.take() {
            // SAFETY: Requests and decisions remain on the WebView UI thread.
            unsafe {
                // Only an explicit Allow becomes an origin/kind grant. Cancellation and
                // owner retirement keep denying this request without persisting a denial.
                let _ = self.args.SetSavesInProfile(allowed);
                let _ = self.args.SetState(if allowed {
                    COREWEBVIEW2_PERMISSION_STATE_ALLOW
                } else {
                    COREWEBVIEW2_PERMISSION_STATE_DENY
                });
                let _ = deferral.Complete();
            }
        }
    }
}
impl Drop for Permission {
    fn drop(&mut self) {
        self.complete(false);
    }
}
fn take_matching<T>(pending: &mut VecDeque<T>, matches: impl Fn(&T) -> bool) -> VecDeque<T> {
    let (batch, remaining) = pending.drain(..).partition(matches);
    *pending = remaining;
    batch
}

impl Permission {
    fn answer(&mut self, allowed: bool, pending: &PendingPermissions) {
        // Detach the batch before completing COM deferrals: a retry is a new request.
        let batch = take_matching(&mut pending.borrow_mut(), |next| {
            next.owner == self.owner && next.origin == self.origin && next.camera == self.camera
        });
        self.complete(allowed);
        for mut request in batch {
            request.complete(allowed);
        }
    }
}

pub(super) type PendingPermissions = Rc<RefCell<VecDeque<Permission>>>;

pub(super) fn permissions(
    webview: &WebView,
    owner: WindowId,
    pending: PendingPermissions,
    events: EventLoopProxy<ServiceEvent>,
) -> Result<()> {
    // Wry's generic callback omits the requesting origin and deferred decisions.
    unsafe {
        webview.webview().add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = Default::default();
                args.PermissionKind(&mut kind)?;
                if kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                    && kind != COREWEBVIEW2_PERMISSION_KIND_CAMERA
                {
                    return Ok(());
                }
                let mut state = COREWEBVIEW2_PERMISSION_STATE_DEFAULT;
                args.State(&mut state)?;
                if state != COREWEBVIEW2_PERMISSION_STATE_DEFAULT {
                    return Ok(());
                }
                let args = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>()?;
                args.SetSavesInProfile(false)?;
                let mut uri = windows_core::PWSTR::null();
                args.Uri(&mut uri)?;
                let origin = url::Url::parse(&webview2_com::take_pwstr(uri))
                    .ok()
                    .filter(|url| matches!(url.scheme(), "http" | "https"))
                    .map(|url| url.origin().ascii_serialization());
                let Some(origin) = origin else {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                    return Ok(());
                };
                pending.borrow_mut().push_back(Permission {
                    owner,
                    args: args.clone(),
                    deferral: Some(args.GetDeferral()?),
                    origin,
                    camera: kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA,
                });
                let _ = events.send_event(ServiceEvent::Permission);
                Ok(())
            })),
            &mut Default::default(),
        )?;
    }
    Ok(())
}

// The request and WebView retire before the dialog, which retires before its owner.
pub(super) enum Action {
    Media(Permission),
    Reveal(super::reveal::Confirmation),
}
pub(super) struct Prompt {
    request: Action,
    webview: WebView,
    window: Window,
    owner: Rc<Window>,
}
impl Prompt {
    pub(super) fn new(
        target: &EventLoopWindowTarget<ServiceEvent>,
        events: EventLoopProxy<ServiceEvent>,
        context: &mut WebContext,
        request: Action,
        owner: Rc<Window>,
        theme: &Theme,
        language: Language,
    ) -> Result<Self> {
        let size = LogicalSize::new(440.0, 240.0);
        let physical = size.to_physical::<i32>(owner.scale_factor());
        let position = owner.outer_position()?;
        let parent_size = owner.outer_size();
        let window = window_builder()?
            .with_title("Piik")
            .with_owner_window(owner.hwnd())
            .with_skip_taskbar(true)
            .with_decorations(false)
            .with_undecorated_shadow(true)
            .with_resizable(false)
            .with_minimizable(false)
            .with_maximizable(false)
            .with_inner_size(size)
            .with_position(PhysicalPosition::new(
                position.x + (parent_size.width as i32 - physical.width) / 2,
                position.y + (parent_size.height as i32 - physical.height) / 2,
            ))
            .with_visible(false)
            .build(target)?;
        let id = window.id();
        let initial_document = Cell::new(true);
        let (origin, camera, filename) = match &request {
            Action::Media(request) => (Some(&request.origin), request.camera, None),
            Action::Reveal(request) => (None, false, Some(&request.filename)),
        };
        let data = serde_json::json!({
            "origin": origin,
            "camera": camera,
            "filename": filename,
            "theme": theme.code(),
            "language": language.code(),
        });
        let webview = WebViewBuilder::new_with_web_context(context)
            .with_focused(false)
            .with_browser_accelerator_keys(false)
            .with_default_context_menus(false)
            .with_initialization_script(format!("window.piikPermission = {data};"))
            .with_navigation_handler(move |url| {
                url.starts_with("data:text/html;charset=utf-8;base64,")
                    && initial_document.replace(false)
            })
            .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
            .with_ipc_handler(move |message| {
                let event = match message.body().as_str() {
                    "ready" => ServiceEvent::PermissionReady(id),
                    "allow" => ServiceEvent::PermissionDecision(id, true),
                    "deny" => ServiceEvent::PermissionDecision(id, false),
                    _ => return,
                };
                let _ = events.send_event(event);
            })
            .build(&window)?;
        webview.load_html(
            &DOCUMENT
                .replace("__PIIK_PALETTE__", PALETTE)
                .replace("__PIIK_BUTTONS__", BUTTONS)
                .replace("__PIIK_PANEL__", PANEL)
                .replace("__PIIK_BRAND_MARK__", BRAND_MARK)
                .replace("__PIIK_WINDOW_CONTROLS__", CONTROLS),
        )?;
        Ok(Self {
            request,
            webview,
            window,
            owner,
        })
    }

    pub(super) fn id(&self) -> WindowId {
        self.window.id()
    }
    pub(super) fn owner(&self) -> WindowId {
        self.owner.id()
    }

    pub(super) fn show(&self) {
        self.owner.set_enable(false);
        self.window.set_visible(true);
        self.window.set_focus();
        let _ = self.webview.focus();
    }

    pub(super) fn update_appearance(&self, theme: &Theme, language: Language) {
        let _ = self.webview.evaluate_script(&format!(
            "window.updateAppearance('{}','{}')",
            theme.code(),
            language.code()
        ));
    }

    pub(super) fn stale(&self, main: &super::MainWindow) -> bool {
        matches!(&self.request, Action::Reveal(request) if !request.current(main))
    }
    pub(super) fn answer(
        mut self,
        allowed: bool,
        main: Option<&super::MainWindow>,
        pending: &PendingPermissions,
    ) {
        match &mut self.request {
            Action::Media(request) => request.answer(allowed, pending),
            Action::Reveal(request) => {
                if let Some(main) = main {
                    request.answer(main, allowed);
                }
            }
        }
        let owner = self.owner.clone();
        drop(self);
        owner.set_focus();
    }
}
impl Drop for Prompt {
    fn drop(&mut self) {
        // Windows requires the owner to be enabled before destroying its dialog.
        self.owner.set_enable(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_media_requests_share_only_the_first_pending_decision() {
        let active = (1, "https://a.test", false);
        let other = [
            (2, active.1, false),
            (1, "https://b.test", false),
            (1, active.1, true),
        ];
        let mut queue = VecDeque::from([other[0], active, other[1], active, other[2]]);
        assert_eq!(
            take_matching(&mut queue, |key| key == &active),
            [active, active]
        );
        assert_eq!(queue, other);
        queue.push_back(active);
        assert_eq!(queue.pop_back(), Some(active));
    }
}
