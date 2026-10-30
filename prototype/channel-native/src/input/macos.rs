//! Quartz/Accessibility execution only. Consent, grants and release ownership
//! stay in the shared executor; no event tap, worker or CF object crosses threads.
use super::{keyboard, Action, Bounds, Held, Sink, TargetState};
use crate::capture::{Target, TargetKind};
use anyhow::{anyhow, ensure, Result};
use objc2_app_kit::NSEvent;
use objc2_application_services::{AXError, AXUIElement, AXValue, AXValueType};
use objc2_core_foundation::{
    CFArray, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGPoint, CGRect, CGSize,
};
use objc2_core_graphics::*;
use std::{
    collections::{BTreeMap, BTreeSet},
    mem::size_of,
    ptr::NonNull,
    time::Instant,
};

#[derive(Default)]
pub(super) struct System {
    // Quartz needs the injected modifiers, drag state and click count on events.
    // These describe successful OS output, not another grant/permission owner.
    keys: BTreeSet<u16>,
    buttons: BTreeSet<u8>,
    caps: Option<bool>,
    clicks: BTreeMap<u8, Click>,
}
struct Click {
    at: Instant,
    point: CGPoint,
    count: i64,
}

impl Sink for System {
    fn authorize(&mut self) -> Result<()> {
        ensure!(
            CGPreflightPostEventAccess() || CGRequestPostEventAccess(),
            "remote input requires macOS Accessibility permission"
        );
        Ok(())
    }

    fn observe(&mut self, target: &Target) -> TargetState {
        if !CGPreflightPostEventAccess() {
            return TargetState::Suspended;
        }
        let Some(id) = target.source_id.parse::<u32>().ok().filter(|id| *id != 0) else {
            return TargetState::Lost;
        };
        let rect = match target.kind {
            TargetKind::Picker => return TargetState::Lost,
            TargetKind::Display => {
                if !CGDisplayIsActive(id) {
                    return TargetState::Suspended;
                }
                CGDisplayBounds(id)
            }
            TargetKind::Window => {
                let Some(created) = target
                    .creation_time
                    .as_deref()
                    .and_then(|s| s.parse::<u64>().ok())
                    .filter(|n| *n != 0)
                else {
                    return TargetState::Lost;
                };
                if target.pid == 0 || target.pid > i32::MAX as u32 {
                    return TargetState::Lost;
                }
                let mut process: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
                let size = size_of::<libc::proc_bsdinfo>() as i32;
                if unsafe {
                    libc::proc_pidinfo(
                        target.pid as i32,
                        libc::PROC_PIDTBSDINFO,
                        0,
                        (&mut process as *mut libc::proc_bsdinfo).cast(),
                        size,
                    )
                } != size
                {
                    return TargetState::Suspended;
                }
                if process.pbi_start_tvsec * 1_000_000 + process.pbi_start_tvusec != created {
                    return TargetState::Lost;
                }
                let Some(windows) = CGWindowListCopyWindowInfo(CGWindowListOption::OptionAll, 0)
                else {
                    return TargetState::Suspended;
                };
                // CGWindowListCopyWindowInfo returns CF dictionaries whose keys
                // are CFStrings and whose values are Core Foundation objects.
                let windows = unsafe {
                    CFRetained::cast_unchecked::<CFArray<CFDictionary<CFString, CFType>>>(windows)
                };
                let rows: Vec<_> = windows.iter().collect();
                let row = rows.iter().find(|row| unsafe {
                    number(row, kCGWindowNumber) == Some(i64::from(id))
                        && number(row, kCGWindowOwnerPID) == Some(i64::from(target.pid))
                });
                let Some(row) = row else {
                    return TargetState::Lost;
                };
                let Some(rect) = window_bounds(row) else {
                    return TargetState::Suspended;
                };
                // Public AX has no CGWindowID. Only accept the actual focused
                // window when its geometry uniquely identifies this CG window.
                let matches = rows
                    .iter()
                    .filter(|row| unsafe {
                        number(row, kCGWindowOwnerPID) == Some(i64::from(target.pid))
                            && window_bounds(row) == Some(rect)
                    })
                    .count();
                if matches != 1 || !focused(target.pid, rect) {
                    return TargetState::Suspended;
                }
                rect
            }
        };
        if rect.size.width <= 0.0 || rect.size.height <= 0.0 {
            return TargetState::Suspended;
        }
        TargetState::Ready(Bounds {
            left: rect.origin.x as i32,
            top: rect.origin.y as i32,
            width: rect.size.width as i32,
            height: rect.size.height as i32,
        })
    }

    fn apply(&mut self, bounds: Bounds, action: &Action) -> Result<()> {
        ensure!(
            CGPreflightPostEventAccess(),
            "macOS input permission was revoked"
        );
        // CoreGraphics events retain their source. Like rdev's public Quartz
        // adapter, create/post/release within this call instead of moving !Send CF objects.
        let source = CGEventSource::new(CGEventSourceStateID::Private)
            .ok_or_else(|| anyhow!("macOS could not create the input source"))?;
        let event = match action {
            Action::Held(Held::Key(key), down) => {
                let event = CGEvent::new_keyboard_event(Some(&source), *key, *down)
                    .ok_or_else(|| anyhow!("macOS could not create the key event"))?;
                let held = self.keys.contains(key);
                if *key == 57 && *down && !held {
                    self.caps = Some(!self.caps());
                }
                if *down {
                    self.keys.insert(*key);
                } else {
                    self.keys.remove(key);
                }
                if (54..=62).contains(key) {
                    CGEvent::set_type(Some(&event), CGEventType::FlagsChanged);
                } else if held && *down {
                    CGEvent::set_integer_value_field(
                        Some(&event),
                        CGEventField::KeyboardEventAutorepeat,
                        1,
                    );
                }
                event
            }
            Action::Held(Held::Button(button), down) => {
                let button = [0, 2, 1, 3, 4][*button as usize];
                let point = pointer()?;
                let event_type = match (button, down) {
                    (0, true) => CGEventType::LeftMouseDown,
                    (0, false) => CGEventType::LeftMouseUp,
                    (1, true) => CGEventType::RightMouseDown,
                    (1, false) => CGEventType::RightMouseUp,
                    (_, true) => CGEventType::OtherMouseDown,
                    (_, false) => CGEventType::OtherMouseUp,
                };
                let event = CGEvent::new_mouse_event(
                    Some(&source),
                    event_type,
                    point,
                    CGMouseButton(u32::from(button)),
                )
                .ok_or_else(|| anyhow!("macOS could not create the button event"))?;
                if *down {
                    let now = Instant::now();
                    let interval = NSEvent::doubleClickInterval();
                    let count = self
                        .clicks
                        .get(&button)
                        .filter(|click| {
                            now.duration_since(click.at).as_secs_f64() <= interval
                                && (point.x - click.point.x).hypot(point.y - click.point.y) <= 4.0
                        })
                        .map_or(1, |click| click.count + 1);
                    self.clicks.insert(
                        button,
                        Click {
                            at: now,
                            point,
                            count,
                        },
                    );
                    self.buttons.insert(button);
                } else {
                    self.buttons.remove(&button);
                }
                CGEvent::set_integer_value_field(
                    Some(&event),
                    CGEventField::MouseEventClickState,
                    self.clicks.get(&button).map_or(1, |click| click.count),
                );
                event
            }
            Action::Move(_, _) | Action::Relative(_, _) => {
                let point = match action {
                    Action::Move(x, y) => CGPoint {
                        x: f64::from(bounds.left) + x * f64::from(bounds.width - 1),
                        y: f64::from(bounds.top) + y * f64::from(bounds.height - 1),
                    },
                    Action::Relative(dx, dy) => {
                        let p = pointer()?;
                        CGPoint {
                            x: p.x + f64::from(*dx),
                            y: p.y + f64::from(*dy),
                        }
                    }
                    _ => unreachable!(),
                };
                let drag = self.buttons.first().copied();
                let event_type = match drag {
                    None => CGEventType::MouseMoved,
                    Some(0) => CGEventType::LeftMouseDragged,
                    Some(1) => CGEventType::RightMouseDragged,
                    _ => CGEventType::OtherMouseDragged,
                };
                let event = CGEvent::new_mouse_event(
                    Some(&source),
                    event_type,
                    point,
                    CGMouseButton(u32::from(drag.unwrap_or(0))),
                )
                .ok_or_else(|| anyhow!("macOS could not create the pointer event"))?;
                if let Action::Relative(dx, dy) = action {
                    CGEvent::set_integer_value_field(
                        Some(&event),
                        CGEventField::MouseEventDeltaX,
                        i64::from(*dx),
                    );
                    CGEvent::set_integer_value_field(
                        Some(&event),
                        CGEventField::MouseEventDeltaY,
                        i64::from(*dy),
                    );
                }
                event
            }
            Action::Wheel(delta) => CGEvent::new_scroll_wheel_event2(
                Some(&source),
                CGScrollEventUnit::Pixel,
                1,
                *delta,
                0,
                0,
            )
            .ok_or_else(|| anyhow!("macOS could not create the scroll event"))?,
            Action::Text(text) => {
                let text: Vec<u16> = text.encode_utf16().collect();
                for down in [true, false] {
                    let event = CGEvent::new_keyboard_event(Some(&source), 0, down)
                        .ok_or_else(|| anyhow!("macOS could not create the text event"))?;
                    unsafe {
                        CGEvent::keyboard_set_unicode_string(
                            Some(&event),
                            text.len() as u64,
                            text.as_ptr(),
                        );
                    }
                    post(&event, CGEventFlags::empty());
                }
                return Ok(());
            }
        };
        post(&event, self.flags());
        Ok(())
    }
}

impl System {
    fn caps(&self) -> bool {
        self.caps.unwrap_or_else(|| {
            CGEventSource::flags_state(CGEventSourceStateID::CombinedSessionState)
                .contains(CGEventFlags::MaskAlphaShift)
        })
    }
    fn flags(&self) -> CGEventFlags {
        let mut flags = CGEventFlags::empty();
        flags.set(CGEventFlags::MaskAlphaShift, self.caps());
        for key in &self.keys {
            flags |= match key {
                56 | 60 => CGEventFlags::MaskShift,
                59 | 62 => CGEventFlags::MaskControl,
                58 | 61 => CGEventFlags::MaskAlternate,
                54 | 55 => CGEventFlags::MaskCommand,
                _ => CGEventFlags::empty(),
            };
        }
        flags
    }
}

fn post(event: &CGEvent, flags: CGEventFlags) {
    CGEvent::set_flags(Some(event), flags);
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(event));
}
fn pointer() -> Result<CGPoint> {
    let event = CGEvent::new(None).ok_or_else(|| anyhow!("macOS pointer unavailable"))?;
    Ok(CGEvent::location(Some(&event)))
}
fn number(row: &CFDictionary<CFString, CFType>, key: &CFString) -> Option<i64> {
    row.get(key)?.downcast::<CFNumber>().ok()?.as_i64()
}
fn window_bounds(row: &CFDictionary<CFString, CFType>) -> Option<CGRect> {
    let geometry = row
        .get(unsafe { kCGWindowBounds })?
        .downcast::<CFDictionary>()
        .ok()?;
    let mut rect = CGRect::default();
    unsafe { CGRectMakeWithDictionaryRepresentation(Some(&geometry), &mut rect) }.then_some(rect)
}
fn attribute(element: &AXUIElement, name: &str) -> Option<CFRetained<CFType>> {
    let mut value = std::ptr::null();
    let status = unsafe {
        element.copy_attribute_value(&CFString::from_str(name), NonNull::from(&mut value))
    };
    if status != AXError::Success {
        return None;
    }
    NonNull::new(value.cast_mut()).map(|value| unsafe { CFRetained::from_raw(value) })
}
fn focused(pid: u32, rect: CGRect) -> bool {
    let system = unsafe { AXUIElement::new_system_wide() };
    unsafe {
        system.set_messaging_timeout(0.1);
    }
    let Some(app) =
        attribute(&system, "AXFocusedApplication").and_then(|v| v.downcast::<AXUIElement>().ok())
    else {
        return false;
    };
    let mut owner = 0;
    if unsafe { app.pid(NonNull::from(&mut owner)) } != AXError::Success || owner as u32 != pid {
        return false;
    }
    let Some(window) =
        attribute(&app, "AXFocusedWindow").and_then(|v| v.downcast::<AXUIElement>().ok())
    else {
        return false;
    };
    let Some(position) =
        attribute(&window, "AXPosition").and_then(|v| v.downcast::<AXValue>().ok())
    else {
        return false;
    };
    let Some(size) = attribute(&window, "AXSize").and_then(|v| v.downcast::<AXValue>().ok()) else {
        return false;
    };
    let (mut origin, mut extent) = (CGPoint::default(), CGSize::default());
    (unsafe {
        position.value(AXValueType::CGPoint, NonNull::from(&mut origin).cast())
            && size.value(AXValueType::CGSize, NonNull::from(&mut extent).cast())
    }) && (CGRect {
        origin,
        size: extent,
    }) == rect
}

/// The App's existing tick observes only the local stop chord, without a key log.
pub(super) struct Shortcut {
    pub key: u8,
    held: bool,
}
impl Shortcut {
    pub fn new(key: u8) -> Result<Self> {
        ensure!(
            CGPreflightPostEventAccess(),
            "remote input requires macOS Accessibility permission"
        );
        Ok(Self { key, held: false })
    }
    pub fn pressed(&mut self) -> bool {
        let down = |key| CGEventSource::key_state(CGEventSourceStateID::HIDSystemState, key);
        let key = keyboard::scan(&format!("F{}", self.key)).unwrap();
        let pressed = (down(59) || down(62))
            && (down(58) || down(61))
            && !down(54)
            && !down(55)
            && !down(56)
            && !down(60)
            && down(key);
        let rising = pressed && !self.held;
        self.held = pressed;
        rising
    }
}
