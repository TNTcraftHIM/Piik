use std::{sync::mpsc::sync_channel, thread};
use windows::{
    core::Error,
    Win32::{
        Foundation::WPARAM,
        System::Threading::GetCurrentThreadId,
        UI::{
            Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, MOD_NOREPEAT},
            WindowsAndMessaging::{
                GetMessageW, PeekMessageW, PostThreadMessageW, MSG, PM_NOREMOVE, WM_HOTKEY, WM_QUIT,
            },
        },
    },
};

pub use windows::Win32::UI::Input::KeyboardAndMouse::{
    HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN,
};

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
        activated: impl FnMut(usize) + Send + 'static,
    ) -> std::io::Result<(Option<Self>, [Option<Result<(), Error>>; N])> {
        Self::listen(name, bindings, false, activated)
    }

    pub(crate) fn register_stop(
        key: u32,
        activated: impl FnMut(usize) + Send + 'static,
    ) -> std::io::Result<(Option<Self>, [Option<Result<(), Error>>; 4])> {
        let base = MOD_CONTROL | MOD_ALT;
        let bindings = [
            base,
            base | MOD_SHIFT,
            base | MOD_WIN,
            base | MOD_SHIFT | MOD_WIN,
        ]
        .map(|modifiers| Some(Binding { modifiers, key }));
        Self::listen("piik-input-stop", bindings, true, activated)
    }

    fn listen<const N: usize>(
        name: &str,
        bindings: [Option<Binding>; N],
        require_all: bool,
        mut activated: impl FnMut(usize) + Send + 'static,
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
                    if require_all && !matches!(results[id], Some(Ok(()))) {
                        break;
                    }
                }
                let registered = results
                    .each_ref()
                    .map(|result| matches!(result, Some(Ok(()))));
                let active = if require_all {
                    registered.iter().all(|&ok| ok)
                } else {
                    registered.contains(&true)
                };
                if ready.send((GetCurrentThreadId(), active, results)).is_ok() && active {
                    while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                        let id = message.wParam.0;
                        if message.message == WM_HOTKEY && registered.get(id) == Some(&true) {
                            activated(id);
                        }
                    }
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
