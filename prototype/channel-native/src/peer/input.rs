//! Opaque input follows the core's selected lineage on the existing pair.
use super::*;
#[cfg(any(feature = "capture", test))]
use crate::input::SourceView;
use crate::input::{Desktop, Registration, Reply, Source as InputSource};
use futures_util::{stream::SelectAll, Stream};
use piik_channel_core::input::{self, InputBinding, InputFrame, InputRegistration};
use serde::Deserialize;

pub(super) struct Inputs {
    local: Uuid,
    snapshot: watch::Receiver<Option<Snapshot>>,
    #[cfg(any(feature = "capture", test))]
    desktop: Option<Desktop>,
    bindings: HashMap<(Uuid, Uuid), InputBinding>,
    registrations: Vec<InputRegistration>,
    sources: HashMap<Uuid, InputSource>,
    pub replies: SelectAll<std::pin::Pin<Box<dyn Stream<Item = (Uuid, Reply)> + Send + Sync>>>,
}

pub(super) struct Outgoing {
    pub peer: Uuid,
    pub pair: Uuid,
    pub message: data::Message,
}

impl Inputs {
    pub fn new(
        local: Uuid,
        snapshot: watch::Receiver<Option<Snapshot>>,
        desktop: Option<Desktop>,
    ) -> Self {
        #[cfg(not(any(feature = "capture", test)))]
        let _ = desktop;
        Self {
            local,
            snapshot,
            #[cfg(any(feature = "capture", test))]
            desktop: desktop.filter(|_| {
                cfg!(any(
                    target_os = "windows",
                    target_os = "macos",
                    target_os = "linux"
                ))
            }),
            bindings: HashMap::new(),
            registrations: vec![],
            sources: HashMap::new(),
            replies: SelectAll::new(),
        }
    }

    #[cfg(any(feature = "capture", test))]
    pub fn source(
        &mut self,
        publication: Uuid,
        video: Uuid,
        target: crate::capture::Target,
    ) -> Result<Option<(InputSource, watch::Receiver<SourceView>)>> {
        let Some(desktop) = &self.desktop else {
            return Ok(None);
        };
        let (source, replies, state) = desktop.source(publication, video, target)?;
        for registration in self
            .registrations
            .iter()
            .filter(|r| r.publication_id == publication)
        {
            source.register(Registration {
                controller: registration.controller_session_id,
                flow: registration.flow_id,
                secret: registration.secret,
            })?;
        }
        self.replies.push(Box::pin(futures_util::stream::unfold(
            replies,
            move |mut replies| async move {
                replies.recv().await.map(|reply| ((video, reply), replies))
            },
        )));
        self.sources.insert(publication, source.clone());
        Ok(Some((source, state)))
    }

    pub fn registrations(&mut self, registrations: Vec<InputRegistration>) -> Vec<Outgoing> {
        for old in &self.registrations {
            if !registrations.contains(old) {
                if let Some(source) = self.sources.get(&old.publication_id) {
                    let _ = source.retire(old.controller_session_id, old.flow_id);
                }
            }
        }
        let mut ready = Vec::new();
        for registration in &registrations {
            if self.registrations.contains(registration) {
                continue;
            }
            let Some(source) = self.sources.get(&registration.publication_id) else {
                continue;
            };
            if source
                .register(Registration {
                    controller: registration.controller_session_id,
                    flow: registration.flow_id,
                    secret: registration.secret,
                })
                .is_ok()
            {
                let key = (
                    registration.publication_id,
                    registration.controller_session_id,
                );
                if let Some(binding) = self
                    .bindings
                    .get(&key)
                    .filter(|b| b.route_id == registration.flow_id)
                {
                    if let Some(outgoing) = self.reply_frame(binding, None, true) {
                        ready.push(outgoing);
                    }
                }
            }
        }
        self.registrations = registrations;
        ready
    }

    pub fn reconcile(&mut self) {
        let stale: Vec<_> = self
            .bindings
            .iter()
            .filter(|(_, binding)| {
                self.snapshot
                    .borrow()
                    .as_ref()
                    .is_none_or(|state| !binding.current(self.local, state))
            })
            .map(|(key, _)| *key)
            .collect();
        for key in stale {
            self.retire(key);
        }
        let state = self.snapshot.borrow();
        self.sources.retain(|publication, source| {
            let current = state.as_ref().is_some_and(|state| {
                state
                    .publications
                    .iter()
                    .any(|p| p.id == *publication && p.session_id == self.local)
            });
            if !current {
                source.close();
            }
            current
        });
    }

    pub fn disconnected(&mut self, pair: Uuid) -> Vec<Outgoing> {
        let stale: Vec<_> = self
            .bindings
            .iter()
            .filter(|(_, binding)| {
                binding
                    .upstream
                    .iter()
                    .chain(&binding.downstream)
                    .any(|hop| hop.pair_id == pair)
            })
            .map(|(key, _)| *key)
            .collect();
        let mut messages = Vec::new();
        for key in stale {
            let binding = &self.bindings[&key];
            for hop in binding
                .upstream
                .iter()
                .chain(&binding.downstream)
                .filter(|hop| hop.pair_id != pair)
            {
                let frame = InputFrame {
                    publication_id: binding.publication_id,
                    controller_session_id: binding.controller_session_id,
                    route_id: binding.route_id,
                    flow_id: hop.flow_id,
                    data: None,
                    closed: Some(true),
                    ready: None,
                };
                if let Some(message) = self.outgoing(hop.peer_id, binding, &frame) {
                    messages.push(message);
                }
            }
            self.retire(key);
        }
        messages
    }

    fn retire(&mut self, key: (Uuid, Uuid)) {
        if let Some(binding) = self.bindings.remove(&key) {
            if let Some(source) = self.sources.get(&binding.publication_id) {
                let _ = source.release(binding.controller_session_id, binding.route_id);
            }
        }
    }

    #[cfg(any(feature = "capture", test))]
    pub fn end_source(&mut self, publication: Uuid) {
        if let Some(source) = self.sources.remove(&publication) {
            source.close();
        }
        self.bindings.retain(|(id, _), _| *id != publication);
    }

    pub fn close(&mut self) {
        for source in self.sources.values() {
            source.close();
        }
        self.sources.clear();
        self.bindings.clear();
        self.registrations.clear();
    }

    pub fn receive(&mut self, peer: Uuid, mut frame: InputFrame) -> Option<Outgoing> {
        let key = (frame.publication_id, frame.controller_session_id);
        let route = {
            let state = self.snapshot.borrow();
            input::route(
                &mut frame,
                self.local,
                state.as_ref()?,
                Some(peer),
                self.bindings.get(&key),
            )
            .ok()?
        };
        if self
            .bindings
            .get(&key)
            .is_some_and(|old| old != &route.binding)
        {
            self.retire(key);
        }
        self.bindings.insert(key, route.binding.clone());
        if let Some(next) = route.next_hop {
            let message = self.outgoing(next, &route.binding, &frame);
            if frame.closed == Some(true) {
                self.retire(key);
            }
            return message;
        }
        if frame.closed == Some(true) {
            self.retire(key);
            return None;
        }
        let source = self.sources.get(&frame.publication_id)?;
        let packet: Packet = serde_json::from_value(frame.data?).ok()?;
        if packet.id != frame.controller_session_id.simple().to_string()
            || packet.epoch != frame.route_id.simple().to_string()
        {
            return None;
        }
        // Source returns policy/OS failures through its encrypted state, without
        // invalidating this pair's picture, conversation or other controllers.
        let _ = source.receive(frame.controller_session_id, frame.route_id, &packet.data);
        None
    }

    pub fn reply(&self, video: Uuid, reply: Reply) -> Option<Outgoing> {
        if self.sources.get(&reply.publication)?.video() != video {
            return None;
        }
        let binding = self.bindings.get(&(reply.publication, reply.controller))?;
        if binding.route_id != reply.flow {
            return None;
        }
        self.reply_frame(binding, Some(serde_json::json!({
            "id": reply.controller.simple().to_string(), "epoch": reply.flow.simple().to_string(), "data": reply.data
        })), false)
    }

    fn reply_frame(
        &self,
        binding: &InputBinding,
        data: Option<serde_json::Value>,
        ready: bool,
    ) -> Option<Outgoing> {
        let mut frame = InputFrame {
            publication_id: binding.publication_id,
            controller_session_id: binding.controller_session_id,
            route_id: binding.route_id,
            flow_id: binding.downstream.as_ref()?.flow_id,
            data,
            closed: None,
            ready: ready.then_some(true),
        };
        let state = self.snapshot.borrow();
        let route =
            input::route(&mut frame, self.local, state.as_ref()?, None, Some(binding)).ok()?;
        self.outgoing(route.next_hop?, &route.binding, &frame)
    }

    fn outgoing(&self, peer: Uuid, binding: &InputBinding, frame: &InputFrame) -> Option<Outgoing> {
        let pair = binding
            .upstream
            .iter()
            .chain(&binding.downstream)
            .find(|hop| hop.peer_id == peer)?
            .pair_id;
        Some(Outgoing {
            peer,
            pair,
            message: data::Message {
                bytes: serde_json::to_vec(frame).ok()?,
                scope: data::MessageScope::Input {
                    snapshot: self.snapshot.clone(),
                    local: self.local,
                    binding: binding.clone(),
                },
                report_failure: true,
            },
        })
    }
}

impl Drop for Inputs {
    fn drop(&mut self) {
        for source in self.sources.values() {
            source.close();
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Packet {
    id: String,
    epoch: String,
    data: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use piik_channel_core::wire::*;

    fn id(value: u128) -> Uuid {
        Uuid::from_u128(value)
    }
    fn state() -> Snapshot {
        Snapshot {
            files: vec![],
            channel: ChannelInfo {
                history_window: 100,
                id: id(10),
                name: "input".into(),
                icon: Default::default(),
                owner_id: None,
                rooms: vec![],
                roles: vec![],
            },
            users: vec![],
            sessions: vec![SessionInfo {
                id: id(3),
                user_id: id(3),
                online: true,
                signing_key: [0; 32],
            }],
            publications: vec![PublicationInfo {
                id: id(4),
                room_id: "room".into(),
                session_id: id(1),
                user_id: id(1),
                kind: Kind::Screen,
                muted: false,
            }],
            voice: vec![],
            subscriptions: vec![],
            ice_servers: vec![],
            pairs: vec![
                PairInfo {
                    id: id(7),
                    peer_id: id(1),
                    rooms: vec![],
                    outgoing: vec![],
                    incoming: vec![FlowBinding {
                        id: id(5),
                        publication_id: id(4),
                        input_flow_id: None,
                        selected: true,
                    }],
                },
                PairInfo {
                    id: id(8),
                    peer_id: id(3),
                    rooms: vec![],
                    incoming: vec![],
                    outgoing: vec![FlowBinding {
                        id: id(6),
                        publication_id: id(4),
                        input_flow_id: Some(id(5)),
                        selected: true,
                    }],
                },
            ],
        }
    }
    fn frame() -> InputFrame {
        InputFrame {
            publication_id: id(4),
            controller_session_id: id(3),
            route_id: id(6),
            flow_id: id(6),
            data: Some(
                serde_json::json!({ "id": id(3).simple().to_string(), "epoch": id(6).simple().to_string(), "data": "opaque" }),
            ),
            closed: None,
            ready: None,
        }
    }

    #[test]
    fn relay_input_disconnect_notifies_the_surviving_hop_once() {
        let (snapshot, current) = watch::channel(Some(state()));
        let mut input = Inputs::new(id(2), current, None);
        let forwarded = input.receive(id(3), frame()).unwrap();
        assert_eq!(forwarded.peer, id(1));
        let packet: InputFrame = serde_json::from_slice(&forwarded.message.bytes).unwrap();
        assert_eq!(packet.flow_id, id(5));
        assert_eq!(
            packet.data,
            frame().data,
            "relay cannot decode or rewrite ciphertext"
        );
        let closed = input.disconnected(id(8));
        assert_eq!(closed.len(), 1);
        assert_eq!((closed[0].pair, closed[0].peer), (id(7), id(1)));
        let packet: InputFrame = serde_json::from_slice(&closed[0].message.bytes).unwrap();
        assert_eq!(packet.closed, Some(true));
        assert_eq!(packet.flow_id, id(5));
        assert!(input.disconnected(id(8)).is_empty());
        assert!(input.bindings.is_empty());
        assert_eq!(
            snapshot.borrow().as_ref().unwrap().pairs.len(),
            2,
            "input retirement does not edit media routes"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn registration_before_capture_and_after_first_packet_both_resolve() {
        let mut state = state();
        state.pairs.remove(0);
        state.pairs[0].outgoing[0].input_flow_id = None;
        let (_snapshot, current) = watch::channel(Some(state));
        let desktop = Desktop::new().unwrap();
        let mut input = Inputs::new(id(1), current, Some(desktop));
        let mut registration = InputRegistration {
            publication_id: id(4),
            controller_session_id: id(3),
            flow_id: id(6),
            secret: [1; 32],
        };
        assert!(input.registrations(vec![registration.clone()]).is_empty());
        let target = crate::capture::Target {
            kind: crate::capture::TargetKind::Display,
            source_id: "fixture".into(),
            title: "fixture".into(),
            pid: 0,
            creation_time: None,
        };
        let (source, view) = input.source(id(4), id(9), target).unwrap().unwrap();
        assert_eq!(view.borrow().mode, crate::input::Mode::Off);
        assert!(input.receive(id(3), frame()).is_none());
        registration.secret = [2; 32];
        let messages = input.registrations(vec![registration.clone()]);
        assert_eq!(
            messages.len(),
            1,
            "a late private registration asks the controller to resync"
        );
        let packet: InputFrame = serde_json::from_slice(&messages[0].message.bytes).unwrap();
        assert_eq!(packet.ready, Some(true));
        assert_eq!(packet.flow_id, id(6));
        assert!(
            input.registrations(vec![registration]).is_empty(),
            "unchanged registration has no retry loop"
        );
        input.end_source(id(4));
        assert!(source.set_mode(crate::input::Mode::Off).is_err());
    }
}
