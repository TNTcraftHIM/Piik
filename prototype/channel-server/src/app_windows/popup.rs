//! Popup geometry stays ordinary until its own document identifies a PiP panel.
use serde::Deserialize;
use super::{caption, WindowControls};
use tao::{
    dpi::{LogicalPosition, LogicalSize},
    window::WindowBuilder,
};

pub(super) fn builder(
    builder: WindowBuilder,
    size: Option<LogicalSize<f64>>,
    position: Option<LogicalPosition<f64>>,
    controls: &WindowControls,
) -> WindowBuilder {
    let mut builder = builder
        .with_title("Piik")
        .with_inner_size(caption::window_size(size.unwrap_or_else(|| LogicalSize::new(720.0, 760.0)), controls));
    if let Some(position) = position {
        builder = builder.with_position(position);
    }
    builder
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub(super) enum Message {
    Panel { width: f64, height: f64 },
}

impl Message {
    pub(super) fn panel_size(&self) -> Option<LogicalSize<f64>> {
        let Self::Panel { width, height } = *self;
        (width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0)
            .then_some(LogicalSize::new(width, height))
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Mode {
    Pinned,
    Editing,
    Panel,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Overlay {
    pub token: uuid::Uuid,
    pub voice_overlay: Mode,
}

pub(super) fn overlay_script(token: uuid::Uuid) -> String {
    format!(r#"(() => {{
      if (location.href !== 'about:blank' || window !== top) return;

      Object.defineProperty(window, 'piikSetVoiceOverlay', {{value(mode) {{
        if (window.opener?.documentPictureInPicture?.window !== window ||
            !document.querySelector('.c3-room-tool') || !['pinned','editing','panel'].includes(mode)) return false;
        window.opener.ipc.postMessage(JSON.stringify({{token:'{token}',voice_overlay:mode}}));
        return true;
      }} }});
    }})()"#)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tao::dpi::{Position, Size};

    #[test]
    fn ordinary_popup_retains_requested_content_geometry_without_becoming_topmost() {
        let controls = WindowControls { width: 138.0, height: 58.0 };
        let size = LogicalSize::new(420.0, 346.0);
        let position = LogicalPosition::new(30.0, 40.0);
        let popup = builder(WindowBuilder::new(), Some(size), Some(position), &controls);
        assert_eq!(popup.window.inner_size, Some(Size::Logical(LogicalSize::new(420.0, 404.0))));
        assert_eq!(popup.window.position, Some(Position::Logical(position)));
        assert!(!popup.window.always_on_top);
        let default = builder(WindowBuilder::new(), None, None, &controls);
        assert_eq!(
            default.window.inner_size,
            Some(Size::Logical(LogicalSize::new(720.0, 818.0)))
        );
        assert!(!default.window.always_on_top);
    }

    #[test]
    fn panel_requires_its_explicit_kind_and_valid_content_geometry() {
        let message: Message =
            serde_json::from_str(r#"{"kind":"panel","width":304,"height":346}"#).unwrap();
        assert_eq!(message.panel_size(), Some(LogicalSize::new(304.0, 346.0)));
        assert!(
            serde_json::from_str::<Message>(r#"{"kind":"login","width":304,"height":346}"#)
                .is_err()
        );
        assert!(Message::Panel {
            width: 0.0,
            height: 346.0
        }
        .panel_size()
        .is_none());
        assert!(Message::Panel {
            width: f64::NAN,
            height: 346.0
        }
        .panel_size()
        .is_none());
    }
}
