//! Actual Core admissions and stored room operations for session composition tests.
use crate::hosted_room::HostedRoom;
use anyhow::{anyhow, ensure, Result};
use piik_channel_core::{
    wire::{Command, Event, Request, RoomAccess, CHANNEL_PROTOCOL},
    Authority, Effects, RoomState,
};
use std::{
    collections::{BTreeMap, VecDeque},
    path::PathBuf,
};
use uuid::Uuid;

pub struct CoreBurst {
    pub authority: Authority,
    pub hosts: BTreeMap<String, HostedRoom>,
    pub paths: BTreeMap<String, PathBuf>,
    pub connection: Uuid,
    pub session: Uuid,
    pub user: Uuid,
    pub credential: String,
    pub now: u64,
    pub room_ids: Vec<String>,
    _directory: tempfile::TempDir,
}
impl CoreBurst {
    pub fn new() -> Result<Self> {
        let mut authority =
            Authority::new("owned-composition-owner".into(), vec![]).map_err(anyhow::Error::msg)?;
        let connection = Uuid::new_v4();
        let effects = authority.handle(
            connection,
            Request {
                request_id: None,
                command: join(None, None, true),
            },
            1,
        );
        let (session, user, credential) = effects
            .events
            .into_iter()
            .find_map(|(_, e)| match e {
                Event::Welcome {
                    session_id,
                    self_profile,
                    credential,
                    ..
                } => Some((session_id, self_profile.id, credential)),
                _ => None,
            })
            .ok_or_else(|| anyhow!("owner join failed"))?;
        let mut value = Self {
            authority,
            hosts: BTreeMap::new(),
            paths: BTreeMap::new(),
            connection,
            session,
            user,
            credential,
            now: 2,
            room_ids: vec![],
            _directory: tempfile::tempdir()?,
        };
        // Actual endpoint admissions, not manually filled snapshots.
        for i in 1..20 {
            let conn = Uuid::new_v4();
            let e = value.authority.handle(
                conn,
                Request {
                    request_id: None,
                    command: Command::Join {
                        protocol: CHANNEL_PROTOCOL,
                        name: format!("Owned participant {i}"),
                        credential: None,
                        owner_key: None,
                        session_id: None,
                        signing_key: [i as u8; 32],
                        can_prepare_udp: false,
                        can_receive_video_layers: true,
                    },
                },
                value.now,
            );
            value.settle(e)?;
            value.now += 1;
        }
        use base64::Engine;
        let mut image = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==")?;
        image.resize(
            (piik_channel_core::wire::IDENTITY_IMAGE_URL_BYTES - "data:image/png;base64,".len())
                / 4
                * 3,
            0,
        );
        let picture = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(image)
        );
        // The catalog limit, with real stored policy and real HostRegister/HostOutput.
        for i in 0..32 {
            let id = format!("owned-room-{i:02}");
            let path = value._directory.path().join(format!("room-{i}.sqlite"));
            let mut policy = RoomState::new(
                id.clone(),
                format!("Owned room {i}"),
                Default::default(),
                value.user,
                RoomAccess::Public,
                false,
                None,
            )
            .map_err(anyhow::Error::msg)?;
            policy.appearance.picture = Some(picture.clone());
            let host = HostedRoom::create(&path, policy)?;
            let summary = host.summary();
            value.hosts.insert(id.clone(), host);
            value.paths.insert(id.clone(), path);
            value.room_ids.push(id);
            let admitted = value.command(
                Command::AdmitRoom {
                    room: summary.clone(),
                },
                None,
            );
            value.settle(admitted)?;
            let e = value.command(
                Command::HostRegister {
                    room: summary,
                    resume_binding: None,
                },
                None,
            );
            value.settle(e)?;
        }
        Ok(value)
    }
    pub fn browse_catalog(&mut self) -> Result<()> {
        for room_id in self.room_ids.clone() {
            let effects = self.command(
                Command::Browse {
                    room_id,
                    active: true,
                    relay_capacity: None,
                },
                None,
            );
            self.settle(effects)?;
        }
        Ok(())
    }
    pub fn command(&mut self, command: Command, request_id: Option<String>) -> Effects {
        self.now += 1;
        self.authority.handle(
            self.connection,
            Request {
                command,
                request_id,
            },
            self.now,
        )
    }
    pub fn settle(&mut self, effects: Effects) -> Result<Vec<Event>> {
        let mut todo = VecDeque::from(effects.events);
        let mut seen = Vec::new();
        let mut count = 0;
        while let Some((recipient, event)) = todo.pop_front() {
            count += 1;
            ensure!(count < 10000, "Core effects failed to settle");
            if recipient != self.connection {
                continue;
            }
            seen.push(event.clone());
            match event {
                Event::HostBound {
                    room_id,
                    binding_id,
                } => self
                    .hosts
                    .get_mut(&room_id)
                    .ok_or_else(|| anyhow!("unknown bound host"))?
                    .bind(binding_id)?,
                Event::HostInput { room_id, input } => {
                    let output = self
                        .hosts
                        .get_mut(&room_id)
                        .ok_or_else(|| anyhow!("unknown input host"))?
                        .dispatch(input)
                        .map_err(anyhow::Error::msg)?;
                    let next = self.command(Command::HostOutput { room_id, output }, None);
                    todo.extend(next.events);
                }
                Event::Error { code, .. } => return Err(anyhow!("Core rejected fixture: {code}")),
                _ => {}
            }
        }
        Ok(seen)
    }
    pub fn recovery(&mut self) -> Result<Vec<Event>> {
        self.now += 1;
        let effects = self.authority.disconnect(self.connection, self.now);
        self.settle(effects)?;
        self.connection = Uuid::new_v4();
        self.now += 1;
        let effects = self.authority.handle(
            self.connection,
            Request {
                request_id: Some("owned-resume".into()),
                command: join(
                    Some(self.credential.clone()),
                    Some(self.session.to_string()),
                    false,
                ),
            },
            self.now,
        );
        ensure!(effects.close.is_empty());
        let mut events = effects
            .events
            .into_iter()
            .filter_map(|(to, e)| (to == self.connection).then_some(e))
            .collect::<Vec<_>>();
        ensure!(
            matches!(events.first(),Some(Event::Welcome{session_id,..})if *session_id==self.session),
            "not real resumed Welcome"
        );
        // Native Welcome handling re-registers every retained host on this new
        // physical connection. Join alone does not rebind room authority.
        let registrations: Vec<_> = self
            .hosts
            .values()
            .map(|host| (host.summary(), host.binding()))
            .collect();
        for (room, resume_binding) in registrations {
            let effects = self.command(
                Command::HostRegister {
                    room,
                    resume_binding,
                },
                None,
            );
            for (to, event) in effects.events {
                if to == self.connection {
                    if let Event::Error { code, .. } = &event {
                        return Err(anyhow!("resume host rejected: {code}"));
                    }
                    events.push(event);
                }
            }
        }
        Ok(events)
    }
    pub fn update_room(&mut self, index: usize, name: &str) -> Effects {
        self.command(
            Command::UpdateRoom {
                room_id: self.room_ids[index].clone(),
                name: name.into(),
                icon: Default::default(),
                picture: None,
                access: RoomAccess::Public,
                hidden: false,
                voice_bitrate: None,
                relay_capacity: None,
                allow_service_relay: None,
                password: None,
            },
            Some(format!("owned-update-{index}")),
        )
    }
    pub fn stored_name(&self, index: usize) -> Result<String> {
        let host = piik_channel_core::StoredRoomHost::open(&self.paths[&self.room_ids[index]])
            .map_err(|e| anyhow!(e.to_string()))?;
        Ok(host.policy().name.clone())
    }
}
fn join(credential: Option<String>, session_id: Option<String>, owner: bool) -> Command {
    Command::Join {
        protocol: CHANNEL_PROTOCOL,
        name: "Owned Native host".into(),
        credential,
        owner_key: owner.then(|| "owned-composition-owner".into()),
        session_id,
        signing_key: [1; 32],
        can_prepare_udp: false,
        can_receive_video_layers: true,
    }
}
