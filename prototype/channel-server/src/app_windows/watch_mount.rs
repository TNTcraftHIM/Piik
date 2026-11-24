use super::{page::Pages, reveal::origin, MainWindow};
use serde::Deserialize;
use uuid::Uuid;
use wry::WebViewExtWindows;

pub(super) const SCRIPT: &str = r#"(() => {
  if (window !== top) return;
  Object.defineProperty(window, 'piikMountWatchPage', { value(pageId, bounds) {
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      window.addEventListener('piik-mount-' + id, e => resolve(e.detail === true), {once:true});
      window.ipc.postMessage(JSON.stringify({kind:'mountWatchPage', id, pageId, bounds}));
    });
  }});
})()"#;

#[derive(Clone, Deserialize)]
#[serde(tag = "kind")]
pub(super) enum Request {
    #[serde(rename = "watchSharePicker", rename_all = "camelCase")]
    Picker { page_id: Uuid, open: bool },
    #[serde(rename = "mountWatchPage", rename_all = "camelCase")]
    Mount {
        id: Uuid,
        page_id: Uuid,
        bounds: Option<Bounds>,
    },
}

#[derive(Clone, Deserialize)]
pub(super) struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Bounds {
    fn physical(&self, scale: f64, client: tao::dpi::PhysicalSize<u32>) -> Option<wry::Rect> {
        let left = (self.x * scale).round();
        let top = (self.y * scale).round();
        let right = ((self.x + self.width) * scale).round();
        let bottom = ((self.y + self.height) * scale).round();
        if !(left >= 0.0
            && top >= 0.0
            && right > left
            && bottom > top
            && right <= f64::from(client.width)
            && bottom <= f64::from(client.height))
        {
            return None;
        }
        Some(wry::Rect {
            position: tao::dpi::PhysicalPosition::new(left as i32, top as i32).into(),
            size: tao::dpi::PhysicalSize::new((right - left) as u32, (bottom - top) as u32).into(),
        })
    }
}

fn current_site(
    source: &str,
    current_url: Option<&str>,
    generation: u64,
    current_generation: u64,
) -> Option<String> {
    let site = origin(source)?;
    (generation == current_generation && current_url.and_then(origin).as_ref() == Some(&site))
        .then_some(site)
}

impl Request {
    pub(super) fn apply(self, main: &MainWindow, pages: &mut Pages, source: &str, generation: u64) {
        let Some(site) = current_site(
            source,
            main.content.url().ok().as_deref(),
            generation,
            main.document.get(),
        ) else {
            return;
        };
        let (id, page_id, bounds) = match self {
            Self::Picker { page_id, open } => {
                pages.share_picker(page_id, &site, open.then_some(generation));
                return;
            }
            Self::Mount { id, page_id, bounds } => (id, page_id, bounds),
        };
        let result = match bounds {
            None => pages.mount(page_id, &site, &main.window, None),
            Some(bounds) => {
                let mut zoom = 1.0;
                let rect = unsafe { main.content.controller().ZoomFactor(&mut zoom) }
                    .ok()
                    .and_then(|_| {
                        bounds.physical(zoom * main.window.scale_factor(), main.window.inner_size())
                    });
                match rect {
                    Some(rect) => pages.mount(page_id, &site, &main.window, Some(rect)),
                    None => {
                        pages.mount(page_id, &site, &main.window, None);
                        false
                    }
                }
            }
        };
        let _ = main.content.evaluate_script(&format!(
            "window.dispatchEvent(new CustomEvent('piik-mount-{id}',{{detail:{result}}}))"
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mount_requires_current_site_document() {
        let url = Some("https://site.example/room");
        assert_eq!(
            current_site("https://site.example/", url, 3, 3).as_deref(),
            Some("https://site.example")
        );
        assert!(current_site("https://other.example/", url, 3, 3).is_none());
        assert!(current_site("", url, 3, 3).is_none());
        assert!(current_site("https://site.example/", url, 2, 3).is_none());
    }

    #[test]
    fn css_slot_stays_inside_client_after_zoom_and_dpi() {
        let client = tao::dpi::PhysicalSize::new(300, 200);
        let slot = Bounds {
            x: 20.,
            y: 10.,
            width: 100.,
            height: 90.,
        };
        let rect = slot.physical(2., client).unwrap();
        assert_eq!(rect.position.to_physical::<i32>(1.).x, 40);
        assert_eq!(rect.size.to_physical::<u32>(1.).height, 180);
        assert!(slot.physical(3., client).is_none());
    }
}
