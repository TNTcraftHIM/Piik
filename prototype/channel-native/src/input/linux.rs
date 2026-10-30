//! Input on the EIS connection granted to one Portal capture session.
use super::{Action, Bounds, Held, TargetState};
use anyhow::{anyhow, bail, ensure, Context as _, Result};
use reis::{
    ei,
    event::{Device, DeviceCapability, EiEvent, EiEventConverter, Region},
    handshake::EiHandshaker,
    PendingRequestResult,
};
use std::{
    io,
    os::{fd::OwnedFd, unix::net::UnixStream},
    sync::{Arc, Mutex},
};
use tokio::{io::unix::AsyncFd, sync::Notify};

#[derive(Clone)]
pub(crate) struct Endpoint(Arc<Shared>);

struct Shared {
    state: Mutex<State>,
    changed: Notify,
}

struct State {
    connection: Option<reis::event::Connection>,
    devices: Vec<(Device, bool)>,
    mapping_id: Option<String>,
    pending_write: bool,
}

/// Kept on the capture thread: the converter contains local callback handlers.
/// Only Endpoint crosses into the process input executor.
pub(crate) struct Connection {
    io: AsyncFd<ei::Context>,
    events: EiEventConverter,
    endpoint: Endpoint,
    sequence: u32,
}

impl Connection {
    pub(crate) async fn connect(fd: OwnedFd, mapping_id: Option<String>) -> Result<Self> {
        let socket = UnixStream::from(fd);
        let context = ei::Context::new(socket)?;
        // SAFETY: Context owns this fixed UnixStream descriptor; it cannot
        // replace or close it while AsyncFd retains the Context.
        let io = unsafe { AsyncFd::register(context) }?;
        let mut handshake = EiHandshaker::new("Piik", ei::handshake::ContextType::Sender);
        let response = loop {
            let mut readable = io.readable().await?;
            io.get_ref().read()?;
            readable.clear_ready();
            let mut response = None;
            while let Some(event) = io.get_ref().pending_event() {
                if let Some(done) = handshake.handle_event(request(event)?)? {
                    response = Some(done);
                    break;
                }
            }
            flush_initial(&io).await?;
            if let Some(response) = response {
                break response;
            }
        };
        let events = EiEventConverter::new(io.get_ref(), response);
        let endpoint = Endpoint(Arc::new(Shared {
            state: Mutex::new(State {
                connection: Some(events.connection().clone()),
                devices: vec![],
                mapping_id,
                pending_write: false,
            }),
            changed: Notify::new(),
        }));
        Ok(Self {
            io,
            events,
            endpoint,
            sequence: 0,
        })
    }

    pub(crate) fn endpoint(&self) -> Endpoint {
        self.endpoint.clone()
    }

    pub(crate) async fn ready(&mut self) -> Result<()> {
        loop {
            match self.endpoint.observe() {
                TargetState::Ready(_) => return Ok(()),
                TargetState::Lost => bail!("EIS connection ended"),
                TargetState::Suspended => self.dispatch().await?,
            }
        }
    }

    /// One cancellation-safe turn for the capture owner's existing select loop.
    pub(crate) async fn dispatch(&mut self) -> Result<()> {
        // Handshake can leave device announcements already in reis's buffer.
        if self.drain()? {
            return Ok(());
        }
        let shared = self.endpoint.0.clone();
        let changed = shared.changed.notified();
        let pending = {
            let state = self.endpoint.0.state.lock().unwrap();
            ensure!(state.connection.is_some(), "EIS connection ended");
            state.pending_write
        };
        tokio::select! {
            result = self.io.readable() => {
                let mut guard = result?;
                self.io.get_ref().read()?;
                guard.clear_ready();
            }
            result = self.io.writable(), if pending => {
                let mut guard = result?;
                let mut state = self.endpoint.0.state.lock().unwrap();
                if !state.flush()? { guard.clear_ready(); }
            }
            _ = changed => {}
        }
        self.drain()?;
        Ok(())
    }

    fn drain(&mut self) -> Result<bool> {
        let mut consumed = false;
        while let Some(event) = self.io.get_ref().pending_event() {
            self.events.handle_event(request(event)?)?;
            consumed = true;
            while let Some(event) = self.events.next_event() {
                let mut state = self.endpoint.0.state.lock().unwrap();
                let serial = state
                    .connection
                    .as_ref()
                    .context("EIS connection ended")?
                    .serial();
                match event {
                    EiEvent::SeatAdded(event) => event.seat.bind_capabilities(
                        DeviceCapability::Keyboard
                            | DeviceCapability::Pointer
                            | DeviceCapability::PointerAbsolute
                            | DeviceCapability::Button
                            | DeviceCapability::Scroll
                            | DeviceCapability::Text,
                    ),
                    EiEvent::DeviceAdded(event) => state.devices.push((event.device, false)),
                    EiEvent::DeviceResumed(event) => {
                        if let Some((device, resumed)) =
                            state.devices.iter_mut().find(|(d, _)| *d == event.device)
                        {
                            device.device().start_emulating(serial, self.sequence);
                            self.sequence = self.sequence.wrapping_add(1);
                            *resumed = true;
                        }
                    }
                    EiEvent::DevicePaused(event) => {
                        if let Some((_, resumed)) =
                            state.devices.iter_mut().find(|(d, _)| *d == event.device)
                        {
                            *resumed = false;
                        }
                    }
                    EiEvent::DeviceRemoved(event) => {
                        state.devices.retain(|(d, _)| *d != event.device)
                    }
                    EiEvent::Disconnected(event) => {
                        bail!("EIS disconnected: {:?}", event.explanation)
                    }
                    _ => {}
                }
            }
        }
        if consumed {
            self.endpoint.0.state.lock().unwrap().flush()?;
        }
        Ok(consumed)
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        let mut state = self.endpoint.0.state.lock().unwrap();
        state.connection = None;
        state.devices.clear();
        let _ = rustix::net::shutdown(self.io.get_ref(), rustix::net::Shutdown::Both);
    }
}

impl Endpoint {
    pub(super) fn observe(&self) -> TargetState {
        let state = self.0.state.lock().unwrap();
        if state.connection.is_none() {
            TargetState::Lost
        } else if state.device::<ei::Keyboard>().is_some() {
            state
                .region()
                .map_or(TargetState::Suspended, |(_, region)| {
                    TargetState::Ready(Bounds {
                        left: region.x as i32,
                        top: region.y as i32,
                        width: region.width as i32,
                        height: region.height as i32,
                    })
                })
        } else {
            TargetState::Suspended
        }
    }

    pub(super) fn has_text(&self) -> bool {
        self.0.state.lock().unwrap().device::<ei::Text>().is_some()
    }

    pub(super) fn apply(&self, _bounds: Bounds, action: &Action) -> Result<()> {
        let mut state = self.0.state.lock().unwrap();
        // EIS pauses/removes a device in neutral state. Its old releases must
        // not block input on another device or source.
        let already_released = match action {
            Action::Held(Held::Key(_), false) => state.device::<ei::Keyboard>().is_none(),
            Action::Held(Held::Button(_), false) => state.device::<ei::Button>().is_none(),
            _ => false,
        };
        if already_released {
            return Ok(());
        }
        // At most one accepted input batch can remain in reis. Reject the new
        // action before serialization when the previous batch is still blocked.
        ensure!(
            state.flush().inspect_err(|_| self.0.changed.notify_one())?,
            "input_busy"
        );
        let serial = state
            .connection
            .as_ref()
            .context("EIS connection ended")?
            .serial();
        let now = rustix::time::clock_gettime(rustix::time::ClockId::Monotonic);
        let time = now.tv_sec as u64 * 1_000_000 + now.tv_nsec as u64 / 1_000;
        match action {
            Action::Move(x, y) => {
                let (device, region) = state.region().context("input_region_unavailable")?;
                device
                    .interface::<ei::PointerAbsolute>()
                    .unwrap()
                    .motion_absolute(
                        (f64::from(region.x) + x * f64::from(region.width - 1)) as f32,
                        (f64::from(region.y) + y * f64::from(region.height - 1)) as f32,
                    );
                device.device().frame(serial, time);
            }
            Action::Relative(x, y) => {
                let (device, pointer) = state
                    .device::<ei::Pointer>()
                    .context("input_pointer_unavailable")?;
                pointer.motion_relative(*x as f32, *y as f32);
                device.device().frame(serial, time);
            }
            Action::Held(Held::Key(key), down) => {
                let (device, keyboard) = state
                    .device::<ei::Keyboard>()
                    .context("input_keyboard_unavailable")?;
                keyboard.key(
                    u32::from(*key),
                    if *down {
                        ei::keyboard::KeyState::Press
                    } else {
                        ei::keyboard::KeyState::Released
                    },
                );
                device.device().frame(serial, time);
            }
            Action::Held(Held::Button(button), down) => {
                let code = [0x110, 0x112, 0x111, 0x113, 0x114]
                    .get(*button as usize)
                    .context("invalid_button")?;
                let (device, buttons) = state
                    .device::<ei::Button>()
                    .context("input_buttons_unavailable")?;
                buttons.button(
                    *code,
                    if *down {
                        ei::button::ButtonState::Press
                    } else {
                        ei::button::ButtonState::Released
                    },
                );
                device.device().frame(serial, time);
            }
            Action::Wheel(delta) => {
                let (device, scroll) = state
                    .device::<ei::Scroll>()
                    .context("input_scroll_unavailable")?;
                scroll.scroll_discrete(0, -*delta);
                device.device().frame(serial, time);
            }
            Action::Text(text) => {
                let (device, output) = state
                    .device::<ei::Text>()
                    .context("input_text_unavailable")?;
                let mut remaining = text.as_str();
                while !remaining.is_empty() {
                    let mut end = remaining.len().min(254);
                    while !remaining.is_char_boundary(end) {
                        end -= 1;
                    }
                    output.utf8(&remaining[..end]);
                    device.device().frame(serial, time);
                    remaining = &remaining[end..];
                }
            }
        }
        // This batch is accepted into the endpoint's bounded local send buffer.
        // A partial send is never replayed; writable readiness finishes its tail.
        if !state.flush().inspect_err(|_| self.0.changed.notify_one())? {
            self.0.changed.notify_one();
        }
        Ok(())
    }
}

impl State {
    fn flush(&mut self) -> Result<bool> {
        match self
            .connection
            .as_ref()
            .context("EIS connection ended")?
            .flush()
        {
            Ok(()) => {
                self.pending_write = false;
                Ok(true)
            }
            Err(error) => {
                let error = io::Error::from(error);
                if error.kind() == io::ErrorKind::WouldBlock {
                    self.pending_write = true;
                    Ok(false)
                } else {
                    self.connection = None;
                    self.devices.clear();
                    Err(error.into())
                }
            }
        }
    }

    fn device<T: ei::Interface>(&self) -> Option<(&Device, T)> {
        self.devices
            .iter()
            .filter(|(_, ready)| *ready)
            .find_map(|(device, _)| device.interface::<T>().map(|interface| (device, interface)))
    }

    fn region(&self) -> Option<(&Device, &Region)> {
        let mut matching = self
            .devices
            .iter()
            .filter(|(device, ready)| {
                *ready && device.has_capability(DeviceCapability::PointerAbsolute)
            })
            .flat_map(|(device, _)| device.regions().iter().map(move |region| (device, region)))
            .filter(|(_, region)| {
                region.width > 0
                    && region.height > 0
                    && region.x <= i32::MAX as u32
                    && region.y <= i32::MAX as u32
                    && region.width <= i32::MAX as u32
                    && region.height <= i32::MAX as u32
                    && self
                        .mapping_id
                        .as_ref()
                        .is_none_or(|id| region.mapping_id.as_ref() == Some(id))
            });
        let selected = matching.next()?;
        matching.next().is_none().then_some(selected)
    }
}

fn request(event: PendingRequestResult<ei::Event>) -> Result<ei::Event> {
    match event {
        PendingRequestResult::Request(event) => Ok(event),
        PendingRequestResult::ParseError(error) => Err(error.into()),
        PendingRequestResult::InvalidObject(id) => Err(anyhow!("invalid EIS object {id}")),
    }
}

async fn flush_initial(io: &AsyncFd<ei::Context>) -> Result<()> {
    loop {
        match io.get_ref().flush().map_err(io::Error::from) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                let mut guard = io.writable().await?;
                guard.clear_ready();
            }
            Err(error) => return Err(error.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reis::{eis, handshake::EisHandshaker};
    use std::time::Duration;

    #[tokio::test]
    async fn source_owns_socket_during_handshake_and_after_endpoint_cloning() -> Result<()> {
        let (client, server) = UnixStream::pair()?;
        let server = eis::Context::new(server)?;
        {
            let connecting = Connection::connect(client.into(), None);
            tokio::pin!(connecting);
            tokio::select! {
                biased;
                _ = &mut connecting => bail!("handshake completed without a server"),
                _ = tokio::task::yield_now() => {}
            }
        }
        assert_eq!(
            server.read().unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );

        let (client, server) = UnixStream::pair()?;
        let server = eis::Context::new(server)?;
        // SAFETY: eis::Context retains the same owned socket for this scope.
        let server = unsafe { AsyncFd::register(server) }?;
        let mut handshake = EisHandshaker::new(server.get_ref(), 0);
        let respond = async {
            loop {
                let mut ready = server.readable().await?;
                server.get_ref().read()?;
                ready.clear_ready();
                while let Some(message) = server.get_ref().pending_request() {
                    let PendingRequestResult::Request(message) = message else {
                        bail!("invalid client handshake");
                    };
                    if handshake.handle_request(message)?.is_some() {
                        server.get_ref().flush()?;
                        return Ok::<_, anyhow::Error>(());
                    }
                }
            }
        };
        let (connection, _) = tokio::time::timeout(Duration::from_secs(2), async {
            tokio::try_join!(Connection::connect(client.into(), None), respond)
        })
        .await??;
        let retained = connection.endpoint();
        drop(connection);
        assert!(matches!(retained.observe(), TargetState::Lost));
        assert!(retained
            .apply(Bounds::default(), &Action::Held(Held::Key(30), false))
            .is_ok());
        assert!(retained
            .apply(Bounds::default(), &Action::Held(Held::Key(30), true))
            .is_err());
        assert_eq!(
            server.get_ref().read().unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        Ok(())
    }
}
