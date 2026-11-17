//! WebView2 owns file paths, progress and the download dialog; the page observes facts.
use anyhow::Result;
use serde::Serialize;
use std::{cell::Cell, rc::Rc};
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
    Progress { received: i64, total: Option<i64> },
    Saved,
    Cancelled,
    Failed,
}

pub(super) fn install(view: &WebView, report: Option<Rc<dyn Fn(String, Status)>>) -> Result<()> {
    unsafe {
        view.webview()
            .cast::<ICoreWebView2_4>()?
            .add_DownloadStarting(
                &DownloadStartingEventHandler::create(Box::new(move |_, args| {
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
                    observe(&operation, uri, report.clone())
                })),
                &mut Default::default(),
            )?;
    }
    Ok(())
}

// The operation owns both callbacks. They retain no operation reference.
struct Observation {
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
) -> windows_core::Result<()> {
    let observation = Rc::new(Observation {
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
            Some(Status::Saved | Status::Cancelled | Status::Failed)
        ) {
            return Ok(());
        }
        unsafe {
            let mut state = Default::default();
            operation.State(&mut state)?;
            let terminal = if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
                Some(Status::Saved)
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
