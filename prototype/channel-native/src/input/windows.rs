use super::{Action, Bounds, Held, Sink, TargetState};
use crate::capture::{Target, TargetKind};
use crate::windows_hotkeys::{Activation, Binding, Hotkeys};
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

#[derive(Debug)]
pub(super) struct PendingUnicodeRelease(pub u16);

impl std::fmt::Display for PendingUnicodeRelease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Unicode key release pending")
    }
}

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
                TargetKind::Picker => return TargetState::Lost,
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
        Self::apply_with(bounds, action, |inputs| unsafe {
            SendInput(inputs, size_of::<INPUT>() as i32)
        })
    }
}

impl System {
    pub(super) fn apply_with(
        bounds: Bounds,
        action: &Action,
        mut send: impl FnMut(&[INPUT]) -> u32,
    ) -> Result<()> {
        let inputs = match action {
            Action::Held(Held::Unicode(unit), false) => {
                vec![key(*unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)]
            }
            Action::Held(Held::Unicode(_), true) => anyhow::bail!("unexpected_unicode_press"),
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
                    dx: absolute_mouse_coordinate(*x, bounds.left, bounds.width, left, width),
                    dy: absolute_mouse_coordinate(*y, bounds.top, bounds.height, top, height),
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
        let accepted = send(&inputs);
        // UIPI rejection has no reliable GetLastError explanation. Report what
        // Windows accepted; the owner retains permission and only retries releases.
        if accepted as usize != inputs.len() {
            let error = anyhow::anyhow!(
                "Windows accepted {accepted} of {} input events",
                inputs.len()
            );
            if matches!(action, Action::Text(_)) && accepted % 2 == 1 {
                let release = &inputs[accepted as usize];
                if send(std::slice::from_ref(release)) != 1 {
                    // Text records are KEYBDINPUT, with the UTF-16 unit in wScan.
                    let unit = unsafe { release.Anonymous.ki.wScan };
                    return Err(error.context(PendingUnicodeRelease(unit)));
                }
            }
            return Err(error);
        }
        Ok(())
    }
}

// Select the source pixel under the Viewer point, then center the integer Win32
// codes assigned to that pixel by the virtual desktop.
fn absolute_mouse_coordinate(
    position: f64,
    start: i32,
    extent: i32,
    origin: i32,
    size: i32,
) -> i32 {
    let local = (((position + f64::EPSILON) * f64::from(extent)) as i64).min(i64::from(extent) - 1);
    let width = i64::from(size);
    let pixel = (i64::from(start) - i64::from(origin) + local).clamp(0, width - 1);
    let first = (pixel * 65536 + width - 1) / width;
    let last = ((pixel + 1) * 65536 - 1) / width;
    ((first + last) / 2) as i32
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

#[derive(Default)]
pub(super) struct StopPending(std::sync::atomic::AtomicU8);

impl StopPending {
    const ARMED: u8 = 1;
    const PENDING: u8 = 2;

    pub(super) fn arm(&self, active: bool) {
        use std::sync::atomic::Ordering::Relaxed;
        if active {
            self.0.fetch_or(Self::ARMED, Relaxed);
        } else {
            self.0.fetch_and(!Self::ARMED, Relaxed);
        }
    }

    pub(super) fn signal(&self, event: Activation) -> bool {
        use std::sync::atomic::Ordering::Relaxed;
        match event {
            Activation::Registered(_) => {
                self.0.fetch_or(Self::PENDING, Relaxed) & Self::PENDING == 0
            }
            // Admit at the key event. A subsequent release cannot cancel the pending stop.
            Activation::StopChord => self
                .0
                .compare_exchange(Self::ARMED, Self::ARMED | Self::PENDING, Relaxed, Relaxed)
                .is_ok(),
        }
    }

    pub(super) fn take(&self) -> bool {
        self.0
            .fetch_and(!Self::PENDING, std::sync::atomic::Ordering::Relaxed)
            & Self::PENDING
            != 0
    }
}

/// One process hotkey, independent of the number of sites and captures. The
/// thread owns its Windows message queue/registration; the executor owns consent.
pub(super) struct Shortcut {
    pub key: u8,
    _hotkeys: Hotkeys,
}
impl Shortcut {
    pub fn new(
        key: u8,
        pending: std::sync::Arc<StopPending>,
        wake: std::sync::Arc<tokio::sync::Notify>,
    ) -> Result<Self> {
        let (hotkeys, [result]) = Hotkeys::register_stop(
            Binding {
                modifiers: MOD_CONTROL | MOD_ALT,
                key: 0x6f + u32::from(key),
            },
            move |event| {
                if pending.signal(event) {
                    wake.notify_one();
                }
            },
        )?;
        let Some(hotkeys) = hotkeys else {
            anyhow::bail!("input_shortcut_unavailable: {result:?}")
        };
        Ok(Self {
            key,
            _hotkeys: hotkeys,
        })
    }

    #[cfg(test)]
    pub(super) fn notify_test(&self) -> Result<()> {
        self._hotkeys.notify_test(0)?;
        Ok(())
    }
}

#[test]
fn absolute_move_uses_picture_pixel_on_negative_monitor() {
    for (position, extent, pixel) in [
        (0.0, 1024, 0),
        (0.99 / 1024.0, 1024, 0),
        (1.0 / 1024.0, 1024, 1),
        (1.01 / 1024.0, 1024, 1),
        (511.99 / 1024.0, 1024, 511),
        (1.0, 1024, 1023),
        // Actual picturePoint output for source pixel 2 on a 1920-wide image.
        (0.001041666666666663, 1920, 2),
    ] {
        let code = absolute_mouse_coordinate(position, -1600, extent, -1920, 4480);
        assert_eq!(i64::from(code) * 4480 / 65536 - 320, pixel);
    }
}
