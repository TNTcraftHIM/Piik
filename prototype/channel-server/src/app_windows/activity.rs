use super::ServiceEvent;
use anyhow::{ensure, Result};
use tao::{
    event_loop::EventLoopProxy,
    platform::windows::WindowExtWindows,
    window::{Window, WindowId},
};
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{GetForegroundWindow, WM_ACTIVATE, WM_NCDESTROY},
    },
};
use wry::WebView;

type Listener = (WindowId, EventLoopProxy<ServiceEvent>);

pub(super) fn install(window: &Window, events: EventLoopProxy<ServiceEvent>) -> Result<()> {
    let listener = Box::new((window.id(), events));
    let hwnd = HWND(window.hwnd() as _);
    // The UI thread owns the listener until this HWND receives WM_NCDESTROY.
    let installed = unsafe {
        SetWindowSubclass(
            hwnd,
            Some(activation),
            1,
            &*listener as *const Listener as usize,
        )
    };
    ensure!(installed.as_bool(), "register window activation listener");
    let _ = Box::into_raw(listener);
    Ok(())
}

unsafe extern "system" fn activation(
    hwnd: HWND,
    message: u32,
    w: WPARAM,
    l: LPARAM,
    id: usize,
    data: usize,
) -> LRESULT {
    unsafe {
        if message == WM_ACTIVATE {
            let (window, events) = &*(data as *const Listener);
            let _ = events.send_event(ServiceEvent::Activity(*window));
        } else if message == WM_NCDESTROY {
            let _ = RemoveWindowSubclass(hwnd, Some(activation), id);
            drop(Box::from_raw(data as *mut Listener));
        }
        DefSubclassProc(hwnd, message, w, l)
    }
}

pub(super) fn sync(window: &Window, content: &WebView) {
    let active = unsafe { GetForegroundWindow() }.0 as isize == window.hwnd();
    let _ = content.evaluate_script(&format!(
        "if (window.piikNativeActive !== {active}) {{ window.piikNativeActive = {active}; window.dispatchEvent(new Event('piik-window-activity')); }}"
    ));
}
