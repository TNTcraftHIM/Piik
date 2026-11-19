//! WebView2 owns file paths, progress and the download dialog; the page observes facts.
use anyhow::Result;
#[path = "receipt.rs"]
mod receipt;
pub(super) use receipt::ReceiptBook;
use serde::Serialize;
use std::{cell::Cell, rc::Rc};
use uuid::Uuid;
use webview2_com::{
    BytesReceivedChangedEventHandler, DownloadStartingEventHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2DownloadOperation, ICoreWebView2_4,
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED,
        COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED, COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED,
    },
    StateChangedEventHandler,
};
use windows_core::{Interface, PWSTR};
use wry::{WebView, WebViewExtWindows};

pub(super) const SCRIPT: &str =
    "Object.defineProperty(window, 'piikNativeDownloads', { value: true });";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub(super) enum Status {
    Started,
    Progress {
        received: i64,
        total: Option<i64>,
    },
    Saved {
        #[serde(skip_serializing_if = "Option::is_none")]
        receipt: Option<Uuid>,
    },
    Cancelled,
    Failed,
}

pub(super) fn install(
    view: &WebView,
    report: Option<Rc<dyn Fn(String, Status)>>,
    book: Option<Rc<ReceiptBook>>,
) -> Result<()> {
    unsafe {
        view.webview()
            .cast::<ICoreWebView2_4>()?
            .add_DownloadStarting(
                &DownloadStartingEventHandler::create(Box::new(move |sender, args| {
                    let Some(args) = args else { return Ok(()) };
                    // Wry's default allow handler suppresses this UI. Keep the platform owner visible.
                    args.SetHandled(false)?;
                    let Some(report) = &report else { return Ok(()) };
                    let operation = args.DownloadOperation()?;
                    let mut uri = PWSTR::null();
                    operation.Uri(&mut uri)?;
                    let uri = webview2_com::take_pwstr(uri);
                    if !uri.starts_with("blob:") {
                        return Ok(());
                    }
                    if let (Some(view), Some(book)) = (sender, book.clone()) {
                        if observe_marked(&view, &operation, &uri, report.clone(), book).is_some() {
                            return Ok(());
                        }
                    }
                    observe(&operation, uri, report.clone(), None)
                })),
                &mut Default::default(),
            )?;
    }
    Ok(())
}

const MARKED_ATTACHMENT: &str = r#"([origin, url]) => location.origin === origin &&
  Array.from(document.querySelectorAll('a[data-piik-download][data-piik-remember]'))
    .some(link => link.href === url)"#;

// On lookup failure the caller still observes normal download progress.
fn observe_marked(
    view: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    operation: &ICoreWebView2DownloadOperation,
    uri: &str,
    report: Rc<dyn Fn(String, Status)>,
    book: Rc<ReceiptBook>,
) -> Option<()> {
    let mut source = PWSTR::null();
    unsafe { view.Source(&mut source) }.ok()?;
    let origin = super::reveal::origin(&webview2_com::take_pwstr(source))?;
    if url::Url::parse(uri).ok()?.origin().ascii_serialization() != origin {
        return None;
    }
    let args = serde_json::json!([origin, uri]);
    let script = windows_core::HSTRING::from(format!("({MARKED_ATTACHMENT})({args})"));
    let operation = operation.clone();
    let uri = uri.to_owned();
    let completed =
        webview2_com::ExecuteScriptCompletedHandler::create(Box::new(move |err, result| {
            let target = (err.is_ok() && result == "true").then(|| (book.clone(), origin.clone()));
            observe(&operation, uri.clone(), report.clone(), target)
        }));
    unsafe { view.ExecuteScript(&script, &completed) }.ok()
}

// The operation owns both callbacks. They retain no operation reference.
struct Observation {
    target: Option<(Rc<ReceiptBook>, String)>,
    uri: String,
    report: Rc<dyn Fn(String, Status)>,
    bytes: Cell<Option<i64>>,
    state: Cell<Option<i64>>,
    last: Cell<Option<Status>>,
}

fn observe(
    operation: &ICoreWebView2DownloadOperation,
    uri: String,
    report: Rc<dyn Fn(String, Status)>,
    target: Option<(Rc<ReceiptBook>, String)>,
) -> windows_core::Result<()> {
    let observation = Rc::new(Observation {
        target,
        uri,
        report,
        bytes: Cell::new(None),
        state: Cell::new(None),
        last: Cell::new(None),
    });
    unsafe {
        let bytes = observation.clone();
        let mut token = 0;
        operation.add_BytesReceivedChanged(
            &BytesReceivedChangedEventHandler::create(Box::new(move |operation, _| {
                if let Some(operation) = operation {
                    bytes.update(&operation)?;
                }
                Ok(())
            })),
            &mut token,
        )?;
        observation.bytes.set(Some(token));
        let state = observation.clone();
        if let Err(error) = operation.add_StateChanged(
            &StateChangedEventHandler::create(Box::new(move |operation, _| {
                if let Some(operation) = operation {
                    state.update(&operation)?;
                }
                Ok(())
            })),
            &mut token,
        ) {
            let _ = observation.retire(operation);
            return Err(error);
        }
        observation.state.set(Some(token));
    }
    observation.publish(Status::Started);
    observation.update(operation)
}

impl Observation {
    fn publish(&self, status: Status) {
        if self.last.replace(Some(status)) != Some(status) {
            (self.report)(self.uri.clone(), status);
        }
    }

    fn update(&self, operation: &ICoreWebView2DownloadOperation) -> windows_core::Result<()> {
        if matches!(
            self.last.get(),
            Some(Status::Saved { .. } | Status::Cancelled | Status::Failed)
        ) {
            return Ok(());
        }
        unsafe {
            let mut state = Default::default();
            operation.State(&mut state)?;
            let terminal = if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
                Some(Status::Saved {
                    receipt: self.target.as_ref().and_then(|(book, origin)| {
                        let mut path = PWSTR::null();
                        operation.ResultFilePath(&mut path).ok()?;
                        book.remember(
                            origin,
                            std::path::Path::new(&webview2_com::take_pwstr(path)),
                        )
                    }),
                })
            } else if state == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED {
                let mut reason = Default::default();
                operation.InterruptReason(&mut reason)?;
                if reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED {
                    Some(Status::Cancelled)
                } else {
                    let mut resumable = Default::default();
                    operation.CanResume(&mut resumable)?;
                    (!resumable.as_bool()).then_some(Status::Failed)
                }
            } else {
                None
            };
            if let Some(status) = terminal {
                self.publish(status);
                return self.retire(operation);
            }
            let (mut received, mut total) = (0, 0);
            operation.BytesReceived(&mut received)?;
            operation.TotalBytesToReceive(&mut total)?;
            // WebView2 uses -1 for unknown size; a resumed download can restart at zero.
            self.publish(Status::Progress {
                received,
                total: (total >= 0).then_some(total),
            });
        }
        Ok(())
    }

    fn retire(&self, operation: &ICoreWebView2DownloadOperation) -> windows_core::Result<()> {
        unsafe {
            let bytes = self
                .bytes
                .take()
                .map(|token| operation.remove_BytesReceivedChanged(token));
            let state = self
                .state
                .take()
                .map(|token| operation.remove_StateChanged(token));
            bytes.transpose().and(state.transpose()).map(|_| ())
        }
    }
}

pub(super) fn report(view: &WebView, url: &str, status: Status) {
    let detail = serde_json::json!([url, status]);
    let _ = view.evaluate_script(&format!("(({REPORT})(...{detail}))"));
}

// The anchor retires with its document or its caller. No old URL reaches a new page.
const REPORT: &str = r#"(url, status) => {
  if (new URL(url).origin !== window.origin) return;
  const link = [...document.querySelectorAll('a[data-piik-download]')].find(link => link.href === url);
  link?.dispatchEvent(new CustomEvent('piik-native-download', { detail: status }));
}"#;

#[cfg(test)]
#[path = "download_tests.rs"]
mod tests;
