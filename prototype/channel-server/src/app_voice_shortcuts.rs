use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};

pub(super) const AVAILABLE: bool = cfg!(all(windows, feature = "capture"));

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Settings {
    enabled: bool,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    microphone: Option<Binding>,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    listening: Option<Binding>,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Binding {
    key: String,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
}

impl Binding {
    fn virtual_key(&self) -> Result<u32> {
        ensure!(self.ctrl || self.alt || self.meta, "invalid_voice_shortcut");
        let key = match self.key.as_bytes() {
            [key @ (b'A'..=b'Z' | b'0'..=b'9')] => u32::from(*key),
            [b'F', digit @ b'1'..=b'9'] => 0x6f + u32::from(digit - b'0'),
            b"F10" => 0x79,
            b"F11" => 0x7a,
            _ => anyhow::bail!("invalid_voice_shortcut"),
        };
        Ok(key)
    }
}

#[derive(Clone, Copy, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Status {
    Unbound,
    #[cfg(all(windows, feature = "capture"))]
    Unavailable,
    #[cfg(all(windows, feature = "capture"))]
    Registered,
}

#[derive(Serialize)]
pub(super) struct Report {
    microphone: Status,
    listening: Status,
}

#[derive(Default)]
pub(super) struct Owner(#[cfg(all(windows, feature = "capture"))] std::sync::atomic::AtomicBool);

pub(super) struct Connection<'a> {
    _owner: &'a Owner,
    #[cfg(all(windows, feature = "capture"))]
    lease: Option<windows::Lease<'a>>,
}

impl Owner {
    pub(super) fn connect(&self) -> Connection<'_> {
        Connection {
            _owner: self,
            #[cfg(all(windows, feature = "capture"))]
            lease: None,
        }
    }
}

impl Connection<'_> {
    pub(super) fn configure(&mut self, settings: Settings) -> Result<Report> {
        let Settings {
            enabled,
            microphone,
            listening,
        } = settings;
        ensure!(
            enabled || (microphone.is_none() && listening.is_none()),
            "invalid_voice_shortcut"
        );
        ensure!(
            microphone.is_none() || microphone != listening,
            "invalid_voice_shortcut"
        );
        for binding in [&microphone, &listening].into_iter().flatten() {
            binding.virtual_key()?;
        }
        ensure!(AVAILABLE, "voice_shortcuts_unavailable");
        #[cfg(all(windows, feature = "capture"))]
        if enabled {
            if self.lease.is_none() {
                self.lease = Some(windows::Lease::acquire(self._owner)?);
            }
            return self
                .lease
                .as_mut()
                .unwrap()
                .register([microphone, listening]);
        } else {
            self.lease = None;
        }
        Ok(Report {
            microphone: Status::Unbound,
            listening: Status::Unbound,
        })
    }

    pub(super) async fn next(&mut self) -> serde_json::Value {
        #[cfg(all(windows, feature = "capture"))]
        if let Some(lease) = &mut self.lease {
            if let Some(activation) = lease.receive().await {
                return activation.wire();
            }
        }
        std::future::pending().await
    }
}

#[cfg(all(windows, feature = "capture"))]
mod windows {
    use super::{Binding, Owner, Report, Status};
    use anyhow::{ensure, Result};
    use piik_channel_native::windows_hotkeys::{
        Binding as HotkeyBinding, Hotkeys, HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_SHIFT,
        MOD_WIN,
    };
    use serde::Serialize;
    use std::{
        sync::atomic::Ordering,
        time::{SystemTime, UNIX_EPOCH},
    };
    use tokio::sync::mpsc;

    #[derive(Clone, Copy, Serialize)]
    #[serde(rename_all = "snake_case")]
    enum Action {
        ToggleMicrophone,
        ToggleListening,
    }

    pub(super) struct Activation {
        action: Action,
        activated_at_ms: u64,
    }

    impl Activation {
        fn now(action: Action) -> Option<Self> {
            let elapsed = SystemTime::now().duration_since(UNIX_EPOCH).ok()?;
            Some(Self {
                action,
                activated_at_ms: elapsed.as_millis().try_into().ok()?,
            })
        }

        pub(super) fn wire(self) -> serde_json::Value {
            serde_json::json!({
                "type": "voice_shortcut", "action": self.action, "activatedAtMs": self.activated_at_ms
            })
        }
    }

    pub(super) struct Lease<'a> {
        owner: &'a Owner,
        hotkeys: Option<Hotkeys>,
        events: Option<mpsc::Receiver<Activation>>,
    }

    impl<'a> Lease<'a> {
        pub(super) fn acquire(owner: &'a Owner) -> Result<Self> {
            ensure!(
                owner
                    .0
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok(),
                "voice_shortcuts_in_use"
            );
            Ok(Self {
                owner,
                hotkeys: None,
                events: None,
            })
        }

        pub(super) fn register(&mut self, bindings: [Option<Binding>; 2]) -> Result<Report> {
            let mut requested = [false; 2];
            let mut hotkeys = [None, None];
            for (index, binding) in bindings.into_iter().enumerate() {
                let Some(binding) = binding else {
                    continue;
                };
                requested[index] = true;
                let key = binding.virtual_key()?;
                let mut modifiers = HOT_KEY_MODIFIERS::default();
                for (use_modifier, flag) in [
                    (binding.ctrl, MOD_CONTROL),
                    (binding.alt, MOD_ALT),
                    (binding.shift, MOD_SHIFT),
                    (binding.meta, MOD_WIN),
                ] {
                    if use_modifier {
                        modifiers |= flag;
                    }
                }
                // Reserve the existing remote-control stop combinations for their owner.
                if !(modifiers == (MOD_CONTROL | MOD_ALT) && (0x70..=0x7a).contains(&key)) {
                    hotkeys[index] = Some(HotkeyBinding { modifiers, key });
                }
            }
            self.stop();
            let mut status = requested.map(|set| {
                if set {
                    Status::Unavailable
                } else {
                    Status::Unbound
                }
            });
            if hotkeys.iter().any(Option::is_some) {
                let (send, receive) = mpsc::channel(1);
                let actions = [Action::ToggleMicrophone, Action::ToggleListening];
                if let Ok((hotkeys, results)) =
                    Hotkeys::register("piik-voice-shortcuts", hotkeys, move |id| {
                        if let Some(activation) = Activation::now(actions[id]) {
                            let _ = send.try_send(activation);
                        }
                    })
                {
                    for (index, result) in results.into_iter().enumerate() {
                        if matches!(result, Some(Ok(()))) {
                            status[index] = Status::Registered;
                        }
                    }
                    if hotkeys.is_some() {
                        self.hotkeys = hotkeys;
                        self.events = Some(receive);
                    }
                }
            }
            let [microphone, listening] = status;
            Ok(Report {
                microphone,
                listening,
            })
        }

        pub(super) async fn receive(&mut self) -> Option<Activation> {
            self.events.as_mut()?.recv().await
        }

        fn stop(&mut self) {
            self.events = None;
            self.hotkeys = None;
        }
    }

    impl Drop for Lease<'_> {
        fn drop(&mut self) {
            self.stop();
            self.owner.0.store(false, Ordering::Release);
        }
    }

    #[cfg(test)]
    #[tokio::test]
    async fn voice_shortcut_event_keeps_the_activation_time_after_queuing() {
        use std::time::Duration;

        let (send, events) = mpsc::channel(2);
        let owner = Owner::default();
        let mut connection = owner.connect();
        let mut lease = Lease::acquire(&owner).unwrap();
        lease.events = Some(events);
        connection.lease = Some(lease);
        let before = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
        for action in [Action::ToggleMicrophone, Action::ToggleListening] {
            send.try_send(Activation::now(action).unwrap())
                .ok()
                .unwrap();
        }
        let after = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
        tokio::time::sleep(Duration::from_millis(1_010)).await;
        for expected in ["toggle_microphone", "toggle_listening"] {
            let event = tokio::time::timeout(Duration::from_secs(1), connection.next())
                .await
                .unwrap();
            assert_eq!(event["type"], "voice_shortcut");
            assert_eq!(event["action"], expected);
            let stamp = Duration::from_millis(event["activatedAtMs"].as_u64().unwrap());
            assert!(stamp.as_millis() >= before.as_millis());
            assert!(stamp <= after);
            let read_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
            assert!(read_at - stamp >= Duration::from_secs(1));
        }
    }
}
