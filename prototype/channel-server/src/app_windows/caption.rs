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
    appearance: RefCell<Appearance>,
    title: RefCell<String>,
}

#[derive(Default)]
struct Appearance(Option<(Theme, Language, Option<ModalMaterial>)>);

impl Appearance {
    fn update(
        &mut self,
        theme: &Theme,
        language: Language,
        material: Option<ModalMaterial>,
    ) -> String {
        self.0 = Some((theme.clone(), language, material.clone()));
        format!(
            "window.updateAppearance(...{})",
            serde_json::json!([theme.code(), language.code(), material])
        )
    }

    fn ready(&mut self, theme: &Theme, language: Language) -> String {
        let (theme, language, material) = self.0.clone().unwrap_or((theme.clone(), language, None));
        self.update(&theme, language, material)
    }

    fn content_loading(&mut self) -> Option<String> {
        let (theme, language, _) = self.0.clone()?;
        Some(self.update(&theme, language, None))
    }
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
            .with_transparent(!standalone)
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
                    "bookmarks" if !standalone => ServiceEvent::OpenBookmarks(id),
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
            appearance: RefCell::default(),
            title: RefCell::new(String::new()),
        })
    }

    pub(super) fn appearance(
        &self,
        theme: &Theme,
        language: Language,
        material: Option<ModalMaterial>,
    ) {
        let script = self.appearance.borrow_mut().update(theme, language, material);
        let _ = self.view.evaluate_script(&script);
    }

    pub(super) fn ready(&self, theme: &Theme, language: Language) {
        let script = self.appearance.borrow_mut().ready(theme, language);
        let _ = self.view.evaluate_script(&script);
        let title = self.title.borrow().clone();
        self.title(&title);
    }

    pub(super) fn content_loading(&self) {
        if let Some(script) = self.appearance.borrow_mut().content_loading() {
            let _ = self.view.evaluate_script(&script);
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacing_the_document_clears_modal_material_from_delivery_and_ready_replay() {
        for material in [ModalMaterial::Surface, ModalMaterial::Image] {
            let mut appearance = Appearance::default();
            appearance.update(&Theme::Dark, Language::ZhHant, Some(material));
            let cleared = r#"window.updateAppearance(...["dark","zh-Hant",null])"#;
            assert_eq!(appearance.content_loading().as_deref(), Some(cleared));
            // A loading/error document need not send any appearance of its own.
            assert_eq!(appearance.ready(&Theme::Light, Language::En), cleared);

            let next = appearance.update(&Theme::Light, Language::Ja, Some(ModalMaterial::Surface));
            assert_eq!(
                next,
                r#"window.updateAppearance(...["light","ja","surface"])"#
            );
            assert_eq!(appearance.ready(&Theme::Dark, Language::En), next);
        }
    }

    #[test]
    fn without_document_replacement_the_current_modal_survives_ready_replay() {
        let mut appearance = Appearance::default();
        assert!(appearance.content_loading().is_none());
        assert_eq!(
            appearance.ready(&Theme::Light, Language::Ko),
            r#"window.updateAppearance(...["light","ko",null])"#
        );
        let current = appearance.update(&Theme::Dark, Language::Zh, Some(ModalMaterial::Image));
        assert_eq!(appearance.ready(&Theme::Light, Language::En), current);
    }
}
