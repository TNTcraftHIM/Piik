use super::*;
use std::{sync::mpsc, time::Duration};
use windows::{
    core::w,
    Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW,
    },
};

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
