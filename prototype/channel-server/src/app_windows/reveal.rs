use super::MainWindow;
use serde::Deserialize;
use std::{os::windows::ffi::OsStrExt, path::Path};

use uuid::Uuid;

pub(super) const SCRIPT: &str = r#"(() => {
  if (window !== top) return;
  Object.defineProperty(window, 'piikRevealDownload', { value(receipt) {
    if (typeof receipt !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(receipt)) return Promise.resolve('unavailable');
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2,'0')).join('');
    return new Promise(resolve => {
      window.addEventListener('piik-reveal-' + id, event => resolve(event.detail), {once:true});
      window.ipc.postMessage(JSON.stringify({kind:'revealDownload', receipt, id}));
    });
  }});
})()"#;

#[derive(Clone, Deserialize)]
#[serde(tag = "kind")]
pub(super) enum Request {
    #[serde(rename = "revealDownload")]
    Reveal { receipt: Uuid, id: Uuid },
}

pub(super) fn origin(source: &str) -> Option<String> {
    let url = url::Url::parse(source).ok()?;
    matches!(url.scheme(), "https" | "http").then(|| url.origin().ascii_serialization())
}

#[derive(Clone)]
pub(super) struct Confirmation {
    receipt: Uuid,
    id: Uuid,
    origin: String,
    generation: u64,
    pub(super) filename: String,
}
impl Confirmation {
    pub(super) fn prepare(
        main: &MainWindow,
        request: Request,
        source: &str,
        generation: u64,
    ) -> Option<Self> {
        let Request::Reveal { receipt, id } = request;
        let mut result = Self {
            receipt,
            id,
            origin: origin(source)?,
            generation,
            filename: String::new(),
        };
        if !result.current(main) {
            return None;
        }
        if let Some(path) = main.receipts.resolve(&result.origin, receipt) {
            result.filename = path.file_name()?.to_string_lossy().into_owned();
            Some(result)
        } else {
            result.report(main, "unavailable");
            None
        }
    }
    pub(super) fn current(&self, main: &MainWindow) -> bool {
        main.document.get() == self.generation
            && main
                .content
                .url()
                .ok()
                .and_then(|url| origin(&url))
                .as_ref()
                == Some(&self.origin)
    }
    pub(super) fn answer(&self, main: &MainWindow, allowed: bool) {
        if !self.current(main) {
            return;
        }
        let result = if !allowed {
            "cancelled"
        } else if main
            .receipts
            .resolve(&self.origin, self.receipt)
            .is_some_and(|path| select_file(&path))
        {
            "revealed"
        } else {
            "unavailable"
        };
        self.report(main, result);
    }
    fn report(&self, main: &MainWindow, result: &str) {
        let _ = main.content.evaluate_script(&format!(
            "window.dispatchEvent(new CustomEvent('piik-reveal-{}', {{detail:'{result}'}}))",
            self.id.simple()
        ));
    }
}

// An absolute file PIDL with zero children selects the item in its containing folder.
fn select_file(path: &Path) -> bool {
    use std::ffi::c_void;
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn ILCreateFromPathW(path: *const u16) -> *mut c_void;
        fn SHOpenFolderAndSelectItems(
            item: *const c_void,
            count: u32,
            children: *const *const c_void,
            flags: u32,
        ) -> i32;
        fn ILFree(item: *mut c_void);
    }
    let wide: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        let item = ILCreateFromPathW(wide.as_ptr());
        if item.is_null() {
            return false;
        }
        let result = SHOpenFolderAndSelectItems(item, 0, std::ptr::null(), 0);
        ILFree(item);
        result >= 0
    }
}
