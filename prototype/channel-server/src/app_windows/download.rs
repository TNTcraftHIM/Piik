//! WebView2 owns file paths, progress and the download dialog; the page observes facts.
use anyhow::Result;
use serde::Serialize;
use std::{cell::Cell, rc::Rc};
use webview2_com::{
    DownloadStartingEventHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_4, COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED,
        COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED, COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED,
    },
    StateChangedEventHandler,
};
use windows_core::{Interface, PWSTR};
use wry::{WebView, WebViewExtWindows};

pub(super) const SCRIPT: &str =
    "Object.defineProperty(window, 'piikNativeDownloads', { value: true });";

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Status {
    Started,
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
                    let finished = report.clone();
                    let resource = uri.clone();
                    let token = Rc::new(Cell::new(0));
                    let registered = token.clone();
                    let mut registration = 0;
                    operation.add_StateChanged(
                        &StateChangedEventHandler::create(Box::new(move |operation, _| {
                            let Some(operation) = operation else {
                                return Ok(());
                            };
                            let mut state = Default::default();
                            operation.State(&mut state)?;
                            let status = if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
                                Status::Saved
                            } else if state == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED {
                                let mut reason = Default::default();
                                operation.InterruptReason(&mut reason)?;
                                if reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED {
                                    Status::Cancelled
                                } else {
                                    let mut resumable = Default::default();
                                    operation.CanResume(&mut resumable)?;
                                    if resumable.as_bool() {
                                        return Ok(());
                                    }
                                    Status::Failed
                                }
                            } else {
                                return Ok(());
                            };
                            operation.remove_StateChanged(registered.get())?;
                            finished(resource.clone(), status);
                            Ok(())
                        })),
                        &mut registration,
                    )?;
                    token.set(registration);
                    report(uri, Status::Started);
                    Ok(())
                })),
                &mut Default::default(),
            )?;
    }
    Ok(())
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
