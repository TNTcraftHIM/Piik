use super::{Action, Bounds, Held, Sink, TargetState};
use crate::capture::{Target, TargetKind};
use ::windows::Win32::{
    Foundation::{CloseHandle, FILETIME, HWND, RECT},
    Graphics::{
        Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
        Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO},
    },
    System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    UI::{
        HiDpi::{
            SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT,
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        },
        Input::KeyboardAndMouse::*,
        WindowsAndMessaging::*,
    },
};
use anyhow::{ensure, Result};
use std::{ffi::c_void, mem::size_of};

pub(super) struct System;

// Geometry and injection run synchronously on the caller thread. Restore its DPI
// context, so this executor does not change capture or WebView process defaults.
struct Dpi(DPI_AWARENESS_CONTEXT);
impl Dpi {
    fn enter() -> Self {
        Self(unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) })
    }
}
impl Drop for Dpi {
    fn drop(&mut self) {
        unsafe {
            SetThreadDpiAwarenessContext(self.0);
        }
    }
}

impl Sink for System {
    fn observe(&mut self, target: &Target) -> TargetState {
        let _dpi = Dpi::enter();
        let Ok(id) = target.source_id.parse::<usize>() else {
            return TargetState::Lost;
        };
        if id == 0 {
            return TargetState::Lost;
        }
        let mut rect = RECT::default();
        unsafe {
            match target.kind {
                TargetKind::Display => {
                    let mut info = MONITORINFO {
                        cbSize: size_of::<MONITORINFO>() as u32,
                        ..Default::default()
                    };
                    if !GetMonitorInfoW(HMONITOR(id as *mut c_void), &mut info).as_bool() {
                        return TargetState::Suspended;
                    }
                    rect = info.rcMonitor;
                }
                TargetKind::Window => {
                    let hwnd = HWND(id as *mut c_void);
                    let mut pid = 0;
                    GetWindowThreadProcessId(hwnd, Some(&mut pid));
                    if pid == 0 || pid != target.pid {
                        return TargetState::Lost;
                    }
                    let Some(created) = target
                        .creation_time
                        .as_deref()
                        .and_then(|value| value.parse::<u64>().ok())
                        .filter(|v| *v != 0)
                    else {
                        return TargetState::Lost;
                    };
                    let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
                    else {
                        return TargetState::Suspended;
                    };
                    let (mut creation, mut exit, mut kernel, mut user) = (
                        FILETIME::default(),
                        FILETIME::default(),
                        FILETIME::default(),
                        FILETIME::default(),
                    );
                    let observed =
                        GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user);
                    let _ = CloseHandle(process);
                    if observed.is_err() {
                        return TargetState::Suspended;
                    }
                    if created
                        != (u64::from(creation.dwHighDateTime) << 32
                            | u64::from(creation.dwLowDateTime))
                    {
                        return TargetState::Lost;
                    }
                    if DwmGetWindowAttribute(
                        hwnd,
                        DWMWA_EXTENDED_FRAME_BOUNDS,
                        (&mut rect as *mut RECT).cast(),
                        size_of::<RECT>() as u32,
                    )
                    .is_err()
                        && GetWindowRect(hwnd, &mut rect).is_err()
                    {
                        return TargetState::Suspended;
                    }
                    if IsIconic(hwnd).as_bool()
                        || GetAncestor(GetForegroundWindow(), GA_ROOT) != hwnd
                    {
                        return TargetState::Suspended;
                    }
                }
            }
        }
        if rect.right <= rect.left || rect.bottom <= rect.top {
            return TargetState::Suspended;
        }
        TargetState::Ready(Bounds {
            left: rect.left,
            top: rect.top,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
        })
    }

    fn apply(&mut self, bounds: Bounds, action: &Action) -> Result<()> {
        let _dpi = Dpi::enter();
        let inputs = match action {
            Action::Move(x, y) => {
                let (left, top, width, height) = unsafe {
                    (
                        GetSystemMetrics(SM_XVIRTUALSCREEN),
                        GetSystemMetrics(SM_YVIRTUALSCREEN),
                        GetSystemMetrics(SM_CXVIRTUALSCREEN),
                        GetSystemMetrics(SM_CYVIRTUALSCREEN),
                    )
                };
                ensure!(width > 1 && height > 1, "input_desktop_unavailable");
                vec![mouse(MOUSEINPUT {
                    dx: (((f64::from(bounds.left - left) + x * f64::from(bounds.width - 1))
                        * 65535.0
                        / f64::from(width - 1))
                    .clamp(0.0, 65535.0)) as i32,
                    dy: (((f64::from(bounds.top - top) + y * f64::from(bounds.height - 1))
                        * 65535.0
                        / f64::from(height - 1))
                    .clamp(0.0, 65535.0)) as i32,
                    dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                    ..Default::default()
                })]
            }
            Action::Relative(dx, dy) => vec![mouse(MOUSEINPUT {
                dx: *dx,
                dy: *dy,
                dwFlags: MOUSEEVENTF_MOVE,
                ..Default::default()
            })],
            Action::Wheel(delta) => vec![mouse(MOUSEINPUT {
                mouseData: *delta as u32,
                dwFlags: MOUSEEVENTF_WHEEL,
                ..Default::default()
            })],
            Action::Held(Held::Key(scan), down) => vec![key(
                *scan & 0xff,
                KEYEVENTF_SCANCODE
                    | if scan & 0xff00 == 0xe000 {
                        KEYEVENTF_EXTENDEDKEY
                    } else {
                        KEYBD_EVENT_FLAGS(0)
                    }
                    | if *down {
                        KEYBD_EVENT_FLAGS(0)
                    } else {
                        KEYEVENTF_KEYUP
                    },
            )],
            Action::Held(Held::Button(button), down) => {
                let flags = [
                    MOUSEEVENTF_LEFTDOWN,
                    MOUSEEVENTF_MIDDLEDOWN,
                    MOUSEEVENTF_RIGHTDOWN,
                    MOUSEEVENTF_XDOWN,
                    MOUSEEVENTF_XDOWN,
                ][*button as usize];
                vec![mouse(MOUSEINPUT {
                    mouseData: if *button >= 3 { 1 << (*button - 3) } else { 0 },
                    dwFlags: if *down {
                        flags
                    } else {
                        MOUSE_EVENT_FLAGS(flags.0 << 1)
                    },
                    ..Default::default()
                })]
            }
            Action::Text(text) => text
                .encode_utf16()
                .flat_map(|unit| {
                    [
                        key(unit, KEYEVENTF_UNICODE),
                        key(unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
                    ]
                })
                .collect(),
        };
        if inputs.is_empty() {
            return Ok(());
        }
        let accepted = unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) };
        // UIPI rejection has no reliable GetLastError explanation. Report what
        // Windows accepted; the owner retains permission and only retries releases.
        if accepted as usize != inputs.len() {
            // A partial text batch may end between a UTF-16 press/release pair.
            if matches!(action, Action::Text(_)) && accepted % 2 == 1 {
                unsafe {
                    SendInput(
                        &inputs[accepted as usize..accepted as usize + 1],
                        size_of::<INPUT>() as i32,
                    );
                }
            }
            anyhow::bail!(
                "Windows accepted {accepted} of {} input events",
                inputs.len()
            );
        }
        Ok(())
    }
}

fn mouse(mi: MOUSEINPUT) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi },
    }
}
fn key(scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wScan: scan,
                dwFlags: flags,
                ..Default::default()
            },
        },
    }
}

/// One process hotkey, independent of the number of sites and captures. The
/// thread owns its Windows message queue/registration; the executor owns consent.
pub(super) struct Shortcut {
    pub key: u8,
    thread_id: u32,
    task: Option<std::thread::JoinHandle<()>>,
}
impl Shortcut {
    pub fn new(key: u8, owner: std::sync::Weak<std::sync::Mutex<super::Executor>>) -> Result<Self> {
        let (ready, started) = std::sync::mpsc::sync_channel(1);
        let task = std::thread::Builder::new()
            .name("piik-input-stop".into())
            .spawn(move || unsafe {
                let mut message = MSG::default();
                // Create the queue before publishing its id to the closing owner.
                let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
                if let Err(error) = RegisterHotKey(
                    None,
                    1,
                    MOD_CONTROL | MOD_ALT | MOD_NOREPEAT,
                    0x6f + u32::from(key),
                ) {
                    let _ = ready.send(Err(error));
                    return;
                }
                let id = ::windows::Win32::System::Threading::GetCurrentThreadId();
                if ready.send(Ok(id)).is_ok() {
                    while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                        if message.message == WM_HOTKEY {
                            if let Some(owner) = owner.upgrade() {
                                owner.lock().unwrap().revoke();
                            }
                        }
                    }
                }
                let _ = UnregisterHotKey(None, 1);
            })?;
        match started.recv() {
            Ok(Ok(thread_id)) => Ok(Self {
                key,
                thread_id,
                task: Some(task),
            }),
            result => {
                let _ = task.join();
                anyhow::bail!("input_shortcut_unavailable: {result:?}")
            }
        }
    }

    #[cfg(test)]
    pub(super) fn notify_test(&self) -> Result<()> {
        unsafe {
            PostThreadMessageW(
                self.thread_id,
                WM_HOTKEY,
                Default::default(),
                Default::default(),
            )?;
        }
        Ok(())
    }
}
impl Drop for Shortcut {
    fn drop(&mut self) {
        unsafe {
            let _ = PostThreadMessageW(
                self.thread_id,
                WM_QUIT,
                Default::default(),
                Default::default(),
            );
        }
        if let Some(task) = self.task.take() {
            let _ = task.join();
        }
    }
}
