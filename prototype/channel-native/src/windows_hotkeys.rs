use std::{cell::OnceCell, sync::mpsc::sync_channel, thread};
use windows::{
    core::Error,
    Win32::{
        Foundation::{LPARAM, LRESULT, WPARAM},
        System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
        UI::{
            Input::KeyboardAndMouse::{
                GetAsyncKeyState, RegisterHotKey, UnregisterHotKey, MOD_NOREPEAT, VIRTUAL_KEY,
                VK_CONTROL, VK_MENU,
            },
            WindowsAndMessaging::{
                CallNextHookEx, GetMessageW, PeekMessageW, PostThreadMessageW, SetWindowsHookExW,
                UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, MSG, PM_NOREMOVE, WH_KEYBOARD_LL,
                WM_HOTKEY, WM_KEYDOWN, WM_QUIT, WM_SYSKEYDOWN,
            },
        },
    },
};

pub use windows::Win32::UI::Input::KeyboardAndMouse::{
    HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN,
};

struct StopObserver {
    key: u32,
    matched: Box<dyn Fn() + Send>,
}
thread_local! { static STOP_OBSERVER: OnceCell<StopObserver> = const { OnceCell::new() }; }

pub(crate) enum Activation {
    Registered(usize),
    StopChord,
}

fn stop_chord(key: u32, configured: u32, down: impl Fn(VIRTUAL_KEY) -> bool) -> bool {
    key == configured && down(VK_CONTROL) && down(VK_MENU)
}

unsafe extern "system" fn observe_stop(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    unsafe {
        if code == HC_ACTION as i32 && matches!(message.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN) {
            let key = (*(data.0 as *const KBDLLHOOKSTRUCT)).vkCode;
            STOP_OBSERVER.with(|slot| {
                if let Some(observer) = slot.get() {
                    if stop_chord(key, observer.key, |modifier| {
                        GetAsyncKeyState(modifier.0.into()) < 0
                    }) {
                        (observer.matched)();
                    }
                }
            });
        }
        CallNextHookEx(None, code, message, data)
    }
}

pub struct Binding {
    pub modifiers: HOT_KEY_MODIFIERS,
    pub key: u32,
}

/// A dedicated Windows message queue owns these registrations until dropped.
pub struct Hotkeys {
    thread_id: u32,
    task: Option<thread::JoinHandle<()>>,
}

impl Hotkeys {
    pub fn register<const N: usize>(
        name: &str,
        bindings: [Option<Binding>; N],
        mut activated: impl FnMut(usize) + Send + 'static,
    ) -> std::io::Result<(Option<Self>, [Option<Result<(), Error>>; N])> {
        Self::listen(name, bindings, None, move |event| {
            if let Activation::Registered(id) = event {
                activated(id);
            }
        })
    }

    pub(crate) fn register_stop(
        binding: Binding,
        activated: impl Fn(Activation) + Clone + Send + 'static,
    ) -> std::io::Result<(Option<Self>, [Option<Result<(), Error>>; 1])> {
        let on_match = activated.clone();
        let observer = StopObserver {
            key: binding.key,
            matched: Box::new(move || on_match(Activation::StopChord)),
        };
        Self::listen(
            "piik-input-stop",
            [Some(binding)],
            Some(observer),
            activated,
        )
    }

    fn listen<const N: usize>(
        name: &str,
        bindings: [Option<Binding>; N],
        observer: Option<StopObserver>,
        mut activated: impl FnMut(Activation) + Send + 'static,
    ) -> std::io::Result<(Option<Self>, [Option<Result<(), Error>>; N])> {
        let (ready, started) = sync_channel(1);
        let task = thread::Builder::new()
            .name(name.into())
            .spawn(move || unsafe {
                let mut message = MSG::default();
                // Windows requires the queue to exist before another thread posts to it.
                let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
                let mut results = [const { None }; N];
                for (id, binding) in bindings.into_iter().enumerate() {
                    results[id] = binding.map(|binding| {
                        RegisterHotKey(
                            None,
                            id as i32,
                            binding.modifiers | MOD_NOREPEAT,
                            binding.key,
                        )
                    });
                }
                let registered = results
                    .each_ref()
                    .map(|result| matches!(result, Some(Ok(()))));
                let mut active = registered.contains(&true);
                let mut hook = None;
                if let Some(observer) = observer.filter(|_| active) {
                    STOP_OBSERVER.with(|slot| {
                        let _ = slot.set(observer);
                    });
                    match GetModuleHandleW(None).and_then(|module| {
                        SetWindowsHookExW(
                            WH_KEYBOARD_LL,
                            Some(observe_stop),
                            Some(module.into()),
                            0,
                        )
                    }) {
                        Ok(handle) => hook = Some(handle),
                        Err(error) => {
                            results[0] = Some(Err(error));
                            active = false;
                        }
                    }
                }
                if ready.send((GetCurrentThreadId(), active, results)).is_ok() && active {
                    while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                        let id = message.wParam.0;
                        if message.message == WM_HOTKEY && registered.get(id) == Some(&true) {
                            activated(Activation::Registered(id));
                        }
                    }
                }
                if let Some(handle) = hook {
                    let _ = UnhookWindowsHookEx(handle);
                }
                for (id, registered) in registered.into_iter().enumerate() {
                    if registered {
                        let _ = UnregisterHotKey(None, id as i32);
                    }
                }
            })?;
        match started.recv() {
            Ok((thread_id, true, results)) => Ok((
                Some(Self {
                    thread_id,
                    task: Some(task),
                }),
                results,
            )),
            Ok((_, false, results)) => {
                let _ = task.join();
                Ok((None, results))
            }
            Err(error) => {
                let _ = task.join();
                Err(std::io::Error::other(error))
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn notify_test(&self, id: usize) -> windows::core::Result<()> {
        unsafe { PostThreadMessageW(self.thread_id, WM_HOTKEY, WPARAM(id), Default::default()) }
    }
}

impl Drop for Hotkeys {
    fn drop(&mut self) {
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), Default::default());
        }
        if let Some(task) = self.task.take() {
            let _ = task.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn windows_stop_matches_configured_function_with_extra_modifiers() {
        use windows::Win32::UI::Input::KeyboardAndMouse::{VK_LWIN, VK_RWIN, VK_SHIFT};
        for extra in [
            vec![],
            vec![VK_SHIFT],
            vec![VK_LWIN],
            vec![VK_SHIFT, VK_RWIN],
        ] {
            let held = |key| key == VK_CONTROL || key == VK_MENU || extra.contains(&key);
            assert!(stop_chord(0x79, 0x79, held));
            assert!(!stop_chord(0x78, 0x79, |_| panic!(
                "unrelated key queried modifiers"
            )));
            assert!(!stop_chord(0x79, 0x79, |key| key == VK_CONTROL));
            assert!(!stop_chord(0x79, 0x79, |key| key == VK_MENU));
        }
    }

    #[test]
    #[ignore = "scoped Win32 registration; only posts to its own queue"]
    fn windows_hotkeys_dispatch_registered_ids_and_release_on_drop() -> anyhow::Result<()> {
        let key = |key| {
            Some(Binding {
                modifiers: MOD_CONTROL | MOD_ALT | MOD_SHIFT,
                key,
            })
        };
        // F9 and F10 with three modifiers avoid the default Piik bindings.
        let (reserved, [status]) = Hotkeys::register("piik-hotkey-control", [key(0x78)], |_| {})?;
        status.unwrap()?;
        let (send, receive) = sync_channel(2);
        let (voice, [conflict, free]) =
            Hotkeys::register("piik-hotkey-test", [key(0x78), key(0x79)], move |id| {
                let _ = send.try_send(id);
            })?;
        assert!(conflict.unwrap().is_err());
        free.unwrap()?;
        let voice = voice.unwrap();
        voice.notify_test(0)?;
        voice.notify_test(1)?;
        assert_eq!(receive.recv_timeout(Duration::from_secs(2))?, 1);
        assert!(receive.try_recv().is_err());
        drop(voice);
        drop(reserved);
        let (_again, [first, second]) =
            Hotkeys::register("piik-hotkey-release", [key(0x78), key(0x79)], |_| {})?;
        first.unwrap()?;
        second.unwrap()?;
        Ok(())
    }
}
