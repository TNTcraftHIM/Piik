use super::*;
use std::{sync::mpsc, time::Duration};
use windows::{
    core::w,
    Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW,
    },
};

#[test]
fn independent_catalog_failures_preserve_selectable_sources() {
    let failed = || Err(anyhow!("injected enumeration failure"));
    let source = |kind| Target {
        kind,
        source_id: "1".into(),
        title: "Fixture".into(),
        pid: 0,
        creation_time: None,
    };
    let windows = combine_catalogs(Ok(vec![source(TargetKind::Window)]), failed()).unwrap();
    assert!(matches!(windows.as_slice(), [Target { kind: TargetKind::Window, .. }]));
    let displays = combine_catalogs(failed(), Ok(vec![source(TargetKind::Display)])).unwrap();
    assert!(matches!(displays.as_slice(), [Target { kind: TargetKind::Display, .. }]));
    for result in [combine_catalogs(failed(), failed()), combine_catalogs(failed(), Ok(vec![]))] {
        assert_eq!(result.unwrap_err().to_string(), "capture_targets_failed");
    }
    assert!(combine_catalogs(Ok(vec![]), Ok(vec![])).unwrap().is_empty());
}

#[test]
fn catalog_reads_caption_while_own_window_thread_is_busy() {
    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("STATIC"),
            w!("Fixture"),
            WS_OVERLAPPEDWINDOW,
            0,
            0,
            10,
            10,
            None,
            None,
            None,
            None,
        )
        .unwrap()
    };
    let handle = hwnd.0 as usize;
    let (send, read) = mpsc::channel();
    let worker = thread::spawn(move || {
        let window = Window::from_raw_hwnd(handle as _);
        let _ = send.send(catalog_window_title(&window, window.process_id().unwrap()));
    });
    // This window belongs to the waiting thread, which is not pumping messages.
    let title = read.recv_timeout(Duration::from_secs(2));
    unsafe { DestroyWindow(hwnd).unwrap() };
    worker.join().unwrap();
    assert_eq!(title.unwrap().as_deref(), Some("Fixture"));
}
