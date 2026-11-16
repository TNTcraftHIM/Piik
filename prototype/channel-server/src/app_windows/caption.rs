//! Compiled, trusted window controls; website WebViews never receive this handler.
use super::{
    Language, ModalMaterial, ServiceEvent, Theme, WindowAction, WindowControls, CAPTION, CONTROLS,
    MODAL_BACKDROP, PALETTE,
};
use anyhow::Result;
use std::cell::{Cell, RefCell};
use tao::{
    dpi::{LogicalPosition, LogicalSize},
    event_loop::EventLoopProxy,
    window::Window,
};
use wry::{NewWindowResponse, WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};

pub(super) struct Caption {
    pub(super) view: WebView,
    appearance: RefCell<Option<(Theme, Language, Option<ModalMaterial>)>>,
    title: RefCell<String>,
}

impl Caption {
    pub(super) fn new(
        window: &Window,
        content: &WebView,
        events: EventLoopProxy<ServiceEvent>,
        controls: &WindowControls,
        standalone: bool,
    ) -> Result<Self> {
        let id = window.id();
        let initial = Cell::new(true);
        let view = WebViewBuilder::new()
            .with_environment(content.environment())
            .with_browser_accelerator_keys(false)
            .with_default_context_menus(false)
            .with_initialization_script(format!("window.piikCaptionStandalone = {standalone};"))
            .with_bounds(wry::Rect {
                position: LogicalPosition::new(0.0, 0.0).into(),
                size: controls.size().into(),
            })
            .with_navigation_handler(move |url| {
                url.starts_with("data:text/html;charset=utf-8;base64,") && initial.replace(false)
            })
            .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
            .with_ipc_handler(move |request| {
                let event = match request.body().as_str() {
                    "ready" => ServiceEvent::CaptionReady(id),
                    "minimize" => ServiceEvent::Caption(id, WindowAction::Minimize),
                    "maximize" => ServiceEvent::Caption(id, WindowAction::Maximize),
                    "close" => ServiceEvent::Caption(id, WindowAction::Close),
                    _ => return,
                };
                let _ = events.send_event(event);
            })
            .build_as_child(window)?;
        view.load_html(
            &CAPTION
                .replace("__PIIK_PALETTE__", PALETTE)
                .replace("__PIIK_MODAL_BACKDROP__", MODAL_BACKDROP)
                .replace("__PIIK_WINDOW_CONTROLS__", CONTROLS),
        )?;
        Ok(Self {
            view,
            appearance: RefCell::new(None),
            title: RefCell::new(String::new()),
        })
    }

    pub(super) fn appearance(
        &self,
        theme: &Theme,
        language: Language,
        material: Option<ModalMaterial>,
    ) {
        *self.appearance.borrow_mut() = Some((theme.clone(), language, material.clone()));
        let _ = self.view.evaluate_script(&format!(
            "window.updateAppearance(...{})",
            serde_json::json!([theme.code(), language.code(), material])
        ));
    }

    pub(super) fn ready(&self, theme: &Theme, language: Language) {
        let (theme, language, material) =
            self.appearance
                .borrow()
                .clone()
                .unwrap_or((theme.clone(), language, None));
        self.appearance(&theme, language, material);
        let title = self.title.borrow().clone();
        self.title(&title);
    }

    pub(super) fn title(&self, title: &str) {
        *self.title.borrow_mut() = title.into();
        let _ = self
            .view
            .evaluate_script(&format!("window.updateTitle({})", serde_json::json!(title)));
    }

    pub(super) fn layout(&self, window: &Window, content: &WebView, controls: &WindowControls) {
        let size = window.inner_size().to_logical::<f64>(window.scale_factor());
        let height = controls.height.min(size.height);
        let _ = self.view.set_bounds(wry::Rect {
            position: LogicalPosition::new(0.0, 0.0).into(),
            size: LogicalSize::new(size.width, height).into(),
        });
        let _ = content.set_bounds(wry::Rect {
            position: LogicalPosition::new(0.0, height).into(),
            size: LogicalSize::new(size.width, (size.height - height).max(0.0)).into(),
        });
        let _ = self.view.evaluate_script(&format!(
            "window.updateMaximized({})",
            window.is_maximized()
        ));
    }
}

pub(super) fn window_size(
    content: LogicalSize<f64>,
    controls: &WindowControls,
) -> LogicalSize<f64> {
    LogicalSize::new(content.width, content.height + controls.height)
}

pub(super) fn apply(window: &Window, action: &WindowAction) {
    match action {
        WindowAction::Minimize => window.set_minimized(true),
        WindowAction::Maximize => window.set_maximized(!window.is_maximized()),
        WindowAction::Close => {
            unreachable!("Close is routed by the exact window's lifecycle owner")
        }
    }
}
