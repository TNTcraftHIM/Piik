use super::*;
use std::cell::RefCell;
use webview2_com::Microsoft::Web::WebView2::Win32::*;

#[derive(Default)]
struct Evidence {
    path: RefCell<Option<String>>,
    state: Cell<COREWEBVIEW2_DOWNLOAD_STATE>,
    reason: Cell<COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON>,
    resumable: Cell<bool>,
    received: Cell<i64>,
    total: Cell<i64>,
    state_handler: RefCell<Option<ICoreWebView2StateChangedEventHandler>>,
    bytes_handler: RefCell<Option<ICoreWebView2BytesReceivedChangedEventHandler>>,
    removed: Cell<usize>,
    dropped: Cell<bool>,
    reject_state_subscription: Cell<bool>,
}

#[windows_core::implement(ICoreWebView2DownloadOperation)]
struct Operation {
    evidence: Rc<Evidence>,
}
impl Drop for Operation {
    fn drop(&mut self) {
        self.evidence.state_handler.borrow_mut().take();
        self.evidence.bytes_handler.borrow_mut().take();
        self.evidence.dropped.set(true);
    }
}
#[allow(non_snake_case)]
impl ICoreWebView2DownloadOperation_Impl for Operation_Impl {
    fn add_StateChanged(
        &self,
        handler: windows_core::Ref<ICoreWebView2StateChangedEventHandler>,
        token: *mut i64,
    ) -> windows_core::Result<()> {
        if self.evidence.reject_state_subscription.get() {
            return Err(windows_core::Error::from_hresult(windows_core::HRESULT(
                0x80004005u32 as i32,
            )));
        }
        assert!(self.evidence.state_handler.borrow().is_none());
        self.evidence.state_handler.replace(handler.cloned());
        unsafe {
            *token = 41;
        }
        Ok(())
    }
    fn remove_StateChanged(&self, token: i64) -> windows_core::Result<()> {
        assert_eq!(token, 41);
        assert!(self.evidence.state_handler.borrow_mut().take().is_some());
        self.evidence.removed.set(self.evidence.removed.get() + 1);
        Ok(())
    }
    fn add_BytesReceivedChanged(
        &self,
        handler: windows_core::Ref<ICoreWebView2BytesReceivedChangedEventHandler>,
        token: *mut i64,
    ) -> windows_core::Result<()> {
        assert!(self.evidence.bytes_handler.borrow().is_none());
        self.evidence.bytes_handler.replace(handler.cloned());
        unsafe {
            *token = 42;
        }
        Ok(())
    }
    fn remove_BytesReceivedChanged(&self, token: i64) -> windows_core::Result<()> {
        assert_eq!(token, 42);
        assert!(self.evidence.bytes_handler.borrow_mut().take().is_some());
        self.evidence.removed.set(self.evidence.removed.get() + 1);
        Ok(())
    }
    fn State(&self, value: *mut COREWEBVIEW2_DOWNLOAD_STATE) -> windows_core::Result<()> {
        unsafe {
            *value = self.evidence.state.get();
        }
        Ok(())
    }
    fn InterruptReason(
        &self,
        value: *mut COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON,
    ) -> windows_core::Result<()> {
        unsafe {
            *value = self.evidence.reason.get();
        }
        Ok(())
    }
    fn CanResume(&self, value: *mut windows_core::BOOL) -> windows_core::Result<()> {
        unsafe {
            *value = self.evidence.resumable.get().into();
        }
        Ok(())
    }
    fn TotalBytesToReceive(&self, value: *mut i64) -> windows_core::Result<()> {
        unsafe {
            *value = self.evidence.total.get();
        }
        Ok(())
    }
    fn BytesReceived(&self, value: *mut i64) -> windows_core::Result<()> {
        unsafe {
            *value = self.evidence.received.get();
        }
        Ok(())
    }
    fn add_EstimatedEndTimeChanged(
        &self,
        _: windows_core::Ref<ICoreWebView2EstimatedEndTimeChangedEventHandler>,
        _: *mut i64,
    ) -> windows_core::Result<()> {
        unreachable!()
    }
    fn remove_EstimatedEndTimeChanged(&self, _: i64) -> windows_core::Result<()> {
        unreachable!()
    }
    fn Uri(&self, _: *mut windows_core::PWSTR) -> windows_core::Result<()> {
        unreachable!()
    }
    fn ContentDisposition(&self, _: *mut windows_core::PWSTR) -> windows_core::Result<()> {
        unreachable!()
    }
    fn MimeType(&self, _: *mut windows_core::PWSTR) -> windows_core::Result<()> {
        unreachable!()
    }
    fn EstimatedEndTime(&self, _: *mut windows_core::PWSTR) -> windows_core::Result<()> {
        unreachable!()
    }
    fn ResultFilePath(&self, result: *mut windows_core::PWSTR) -> windows_core::Result<()> {
        unsafe {
            *result = webview2_com::pwstr_from_str(self.evidence.path.borrow().as_ref().unwrap())
        };
        Ok(())
    }
    fn Cancel(&self) -> windows_core::Result<()> {
        unreachable!()
    }
    fn Pause(&self) -> windows_core::Result<()> {
        unreachable!()
    }
    fn Resume(&self) -> windows_core::Result<()> {
        unreachable!()
    }
}

struct Fixture {
    operation: ICoreWebView2DownloadOperation,
    evidence: Rc<Evidence>,
    output: Rc<RefCell<Vec<Status>>>,
}
impl Fixture {
    fn new() -> Self {
        let evidence = Rc::new(Evidence::default());
        evidence.state.set(COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS);
        evidence.total.set(-1);
        Self {
            operation: Operation {
                evidence: evidence.clone(),
            }
            .into(),
            evidence,
            output: Rc::new(RefCell::new(Vec::new())),
        }
    }
    fn observe(&self) -> windows_core::Result<()> {
        let output = self.output.clone();
        observe(
            &self.operation,
            "blob:https://owned.test/fixture".into(),
            Rc::new(move |uri, status| {
                assert_eq!(uri, "blob:https://owned.test/fixture");
                output.borrow_mut().push(status);
            }),
            None,
        )
    }
    fn bytes(&self, received: i64, total: i64) {
        self.evidence.received.set(received);
        self.evidence.total.set(total);
        let handler = self.evidence.bytes_handler.borrow().clone();
        if let Some(handler) = handler {
            unsafe {
                handler
                    .Invoke(&self.operation, None::<&windows_core::IUnknown>)
                    .unwrap();
            }
        }
    }
    fn state(&self, state: COREWEBVIEW2_DOWNLOAD_STATE) {
        self.evidence.state.set(state);
        let handler = self.evidence.state_handler.borrow().clone();
        if let Some(handler) = handler {
            unsafe {
                handler
                    .Invoke(&self.operation, None::<&windows_core::IUnknown>)
                    .unwrap();
            }
        }
    }
    fn assert_retired(&self) {
        assert!(self.evidence.state_handler.borrow().is_none());
        assert!(self.evidence.bytes_handler.borrow().is_none());
        assert_eq!(self.evidence.removed.get(), 2);
        assert_eq!(Rc::strong_count(&self.output), 1);
    }
}

#[test]
fn progress_is_observed_deduplicated_and_can_restart_before_only_completed_saves() {
    let f = Fixture::new();
    f.observe().unwrap();
    f.bytes(16, -1);
    f.bytes(16, -1);
    f.bytes(16, 40);
    f.bytes(40, 40);
    assert_eq!(
        &*f.output.borrow(),
        &[
            Status::Started,
            Status::Progress {
                received: 0,
                total: None
            },
            Status::Progress {
                received: 16,
                total: None
            },
            Status::Progress {
                received: 16,
                total: Some(40)
            },
            Status::Progress {
                received: 40,
                total: Some(40)
            },
        ]
    );
    f.evidence
        .reason
        .set(COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_NO_RANGE);
    f.evidence.resumable.set(true);
    f.state(COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED);
    assert_eq!(f.output.borrow().len(), 5);
    assert_eq!(f.evidence.removed.get(), 0);
    f.evidence.received.set(0);
    f.state(COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS);
    assert_eq!(
        f.output.borrow().last(),
        Some(&Status::Progress {
            received: 0,
            total: Some(40)
        })
    );
    f.bytes(40, 40);
    let late_bytes = f.evidence.bytes_handler.borrow().clone().unwrap();
    f.state(COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED);
    assert_eq!(
        f.output.borrow().last(),
        Some(&Status::Saved { receipt: None })
    );
    assert_eq!(f.evidence.removed.get(), 2);
    unsafe {
        late_bytes
            .Invoke(&f.operation, None::<&windows_core::IUnknown>)
            .unwrap();
    }
    drop(late_bytes);
    f.assert_retired();
    assert_eq!(
        f.output
            .borrow()
            .iter()
            .filter(|state| **state == Status::Saved { receipt: None })
            .count(),
        1
    );
    assert_eq!(
        serde_json::to_value(Status::Progress {
            received: 16,
            total: None
        })
        .unwrap(),
        serde_json::json!({"status":"progress","received":16,"total":null})
    );
    assert_eq!(
        serde_json::to_value(Status::Saved { receipt: None }).unwrap(),
        serde_json::json!({"status":"saved"})
    );
}

#[test]
fn cancel_or_failure_releases_both_subscriptions_without_claiming_saved() {
    for (reason, expected) in [
        (
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED,
            Status::Cancelled,
        ),
        (
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_ACCESS_DENIED,
            Status::Failed,
        ),
    ] {
        let f = Fixture::new();
        f.observe().unwrap();
        f.bytes(8, 16);
        f.evidence.reason.set(reason);
        f.state(COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED);
        assert_eq!(f.output.borrow().last(), Some(&expected));
        assert!(!f.output.borrow().contains(&Status::Saved { receipt: None }));
        f.assert_retired();
    }
}

#[test]
fn operation_drop_releases_the_progress_observer_without_a_reference_cycle() {
    let f = Fixture::new();
    f.observe().unwrap();
    f.bytes(0, 0);
    assert_eq!(
        f.output.borrow().last(),
        Some(&Status::Progress {
            received: 0,
            total: Some(0)
        })
    );
    let Fixture {
        operation,
        evidence,
        output,
    } = f;
    drop(operation);
    assert!(evidence.dropped.get());
    assert!(evidence.state_handler.borrow().is_none());
    assert!(evidence.bytes_handler.borrow().is_none());
    assert_eq!(Rc::strong_count(&output), 1);
    assert!(!output.borrow().contains(&Status::Saved { receipt: None }));
}

#[test]
fn partial_subscription_failure_releases_the_installed_progress_handler() {
    let f = Fixture::new();
    f.evidence.reject_state_subscription.set(true);
    assert!(f.observe().is_err());
    assert_eq!(f.evidence.removed.get(), 1);
    assert!(f.evidence.bytes_handler.borrow().is_none());
    assert!(f.output.borrow().is_empty());
    assert_eq!(Rc::strong_count(&f.output), 1);
}

#[test]
fn receipt_survives_restart_and_checks_origin_file_and_store() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("synthetic.txt");
    let directory = folder.path().join("receipts");
    std::fs::write(&path, b"fixture").unwrap();
    let origin = "https://owned.test";
    let token = ReceiptBook::new(directory.clone())
        .remember(origin, &path)
        .unwrap();
    let book = ReceiptBook::new(directory.clone());
    assert_eq!(book.resolve(origin, token), Some(path.clone()));
    assert_eq!(book.resolve(origin, Uuid::new_v4()), None);
    assert_eq!(book.resolve("https://other.test", token), None);
    std::fs::write(&path, b"changed fixture").unwrap();
    assert_eq!(book.resolve(origin, token), None);
    let updated = book.remember(origin, &path).unwrap();
    std::fs::rename(&path, folder.path().join("moved.txt")).unwrap();
    assert_eq!(book.resolve(origin, updated), None);
    std::fs::write(directory.join("download-receipts.sqlite"), b"corrupt").unwrap();
    assert_eq!(book.resolve(origin, updated), None);
}

#[test]
fn completed_marked_operation_issues_receipt_for_its_own_file() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("completed.txt");
    std::fs::write(&path, b"synthetic attachment").unwrap();
    let book = Rc::new(ReceiptBook::new(temp.path().join("store")));
    let origin = "https://owned.test";
    let f = Fixture::new();
    f.evidence
        .path
        .replace(Some(path.to_str().unwrap().to_owned()));
    let output = f.output.clone();
    observe(
        &f.operation,
        format!("blob:{origin}/fixture"),
        Rc::new(move |_, status| output.borrow_mut().push(status)),
        Some((book.clone(), origin.to_owned())),
    )
    .unwrap();
    f.state(COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED);
    let Some(Status::Saved {
        receipt: Some(token),
    }) = f.output.borrow().last().copied()
    else {
        panic!("missing receipt")
    };
    assert_eq!(book.resolve(origin, token), Some(path));
    f.assert_retired();
}
