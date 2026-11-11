//! Physical WebSocket image transfer. Domain state remains a complete Snapshot.
use crate::wire::{Event, Snapshot, CHANNEL_MESSAGE_BYTES};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Default)]
struct Images {
    domain: Option<Uuid>,
    site: Option<Value>,
    rooms: BTreeMap<String, Value>,
}

impl Images {
    fn from_snapshot(state: &Snapshot) -> Self {
        Self {
            domain: Some(state.channel.id),
            site: Some(serde_json::to_value(&state.channel.icon).unwrap()),
            rooms: state
                .channel
                .rooms
                .iter()
                .map(|room| (room.id.clone(), serde_json::to_value(&room.icon).unwrap()))
                .collect(),
        }
    }

    fn transform(&self, state: &mut Value, decode: bool) -> Result<(), &'static str> {
        let channel = state
            .get_mut("channel")
            .and_then(Value::as_object_mut)
            .ok_or("invalid_channel_event")?;
        let same_domain = channel
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| Uuid::parse_str(id).ok())
            == self.domain;
        field(
            channel,
            "icon",
            same_domain.then_some(self.site.as_ref()).flatten(),
            decode,
        )?;
        for room in channel
            .get_mut("rooms")
            .and_then(Value::as_array_mut)
            .ok_or("invalid_channel_event")?
        {
            let room = room.as_object_mut().ok_or("invalid_channel_event")?;
            let previous = room
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| self.rooms.get(id))
                .filter(|_| same_domain);
            field(room, "icon", previous, decode)?;
        }
        Ok(())
    }
}

fn field(
    object: &mut Map<String, Value>,
    name: &str,
    previous: Option<&Value>,
    decode: bool,
) -> Result<(), &'static str> {
    if decode {
        if !object.contains_key(name) {
            object.insert(
                name.into(),
                previous.ok_or("missing_identity_image")?.clone(),
            );
        }
    } else if object.get(name).is_some_and(|value| {
        Some(value) == previous && value.as_str().is_some_and(|s| s.starts_with("data:"))
    }) {
        object.remove(name);
    }
    Ok(())
}

fn snapshot(event: &Event) -> Option<&Snapshot> {
    match event {
        Event::Welcome { state, .. } | Event::State { state } => Some(state),
        _ => None,
    }
}

#[derive(Default)]
pub struct StateImageEncoder(Images);

impl StateImageEncoder {
    /// The caller must close the socket after a failed write; the next socket starts fresh.
    pub fn encode(&mut self, event: &Event) -> Result<String, serde_json::Error> {
        let Some(state) = snapshot(event) else {
            return serde_json::to_string(event);
        };
        let mut value = serde_json::to_value(event)?;
        if matches!(event, Event::State { .. }) {
            self.0
                .transform(&mut value["state"], false)
                .expect("typed complete snapshot");
        }
        self.0 = Images::from_snapshot(state);
        serde_json::to_string(&value)
    }
}

#[derive(Default)]
pub struct StateImageDecoder(Images);

impl StateImageDecoder {
    pub fn decode(&mut self, text: &str) -> Result<Event, &'static str> {
        if text.len() > CHANNEL_MESSAGE_BYTES {
            return Err("message_too_large");
        }
        let mut value: Value = serde_json::from_str(text).map_err(|_| "invalid_channel_event")?;
        match value.get("type").and_then(Value::as_str) {
            Some("welcome") => Images::default().transform(&mut value["state"], true)?,
            Some("state") => {
                self.0.transform(&mut value["state"], true)?;
                if serde_json::to_vec(&value)
                    .map_err(|_| "invalid_channel_event")?
                    .len()
                    > CHANNEL_MESSAGE_BYTES
                {
                    return Err("message_too_large");
                }
            }
            _ => {}
        }
        let event: Event = serde_json::from_value(value).map_err(|_| "invalid_channel_event")?;
        if let Some(state) = snapshot(&event) {
            self.0 = Images::from_snapshot(state);
        }
        Ok(event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        wire::{Request, CHANNEL_PROTOCOL},
        Authority,
    };
    use serde_json::json;

    fn welcome() -> Event {
        let mut core = Authority::new("owner".into(), vec![]).unwrap();
        core.handle(Uuid::new_v4(), Request::parse(&json!({"type":"join","protocol":CHANNEL_PROTOCOL,"name":"Owner","ownerKey":"owner","signingKey":vec![1;32]}).to_string()).unwrap(), 0)
            .events.into_iter().find_map(|(_, event)| matches!(event, Event::Welcome { .. }).then_some(event)).unwrap()
    }

    #[test]
    fn images_follow_frame_scope_and_subject_lifetime_without_changing_full_state() {
        let mut greeting = welcome();
        let Event::Welcome { state, .. } = &mut greeting else {
            unreachable!()
        };
        let image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==".to_owned();
        let user = state.users[0].id;
        state.channel.icon = image.clone().try_into().unwrap();
        state.channel.rooms.push(
            crate::RoomState::new(
                "room".into(),
                "Room".into(),
                image.clone().try_into().unwrap(),
                user,
                crate::wire::RoomAccess::Public,
                false,
                None,
            )
            .unwrap()
            .view(user)
            .unwrap(),
        );
        let mut state = state.clone();
        let mut encoder = StateImageEncoder::default();
        let mut decoder = StateImageDecoder::default();
        let full = encoder.encode(&greeting).unwrap();
        decoder.decode(&full).unwrap();
        let compact = encoder
            .encode(&Event::State {
                state: state.clone(),
            })
            .unwrap();
        let value: Value = serde_json::from_str(&compact).unwrap();
        assert!(value["state"]["users"][0].get("avatar").is_none());
        assert!(value["state"]["channel"].get("icon").is_none());
        assert!(value["state"]["channel"]["rooms"][0].get("icon").is_none());
        assert_eq!(
            serde_json::to_value(decoder.decode(&compact).unwrap()).unwrap()["state"],
            serde_json::to_value(&state).unwrap()
        );
        assert_eq!(
            StateImageDecoder::default().decode(&compact).err(),
            Some("missing_identity_image")
        );
        let mut wrong_scope = value.clone();
        wrong_scope["state"]["channel"]["id"] = json!(Uuid::new_v4());
        assert_eq!(
            decoder.decode(&wrong_scope.to_string()).err(),
            Some("missing_identity_image")
        );
        let mut new_subject = value.clone();
        new_subject["state"]["channel"]["rooms"][0]["id"] = json!(Uuid::new_v4());
        assert_eq!(
            decoder.decode(&new_subject.to_string()).err(),
            Some("missing_identity_image")
        );
        // A malformed frame never advances the last valid image facts.
        assert!(decoder.decode(&compact).is_ok());
        let replacement = image.replace("HwAFgAI", "HwAFgAJ");
        state.channel.rooms[0].icon = replacement.try_into().unwrap();
        state.channel.icon = "star".to_owned().try_into().unwrap();
        let changed = encoder
            .encode(&Event::State {
                state: state.clone(),
            })
            .unwrap();
        let changed_value: Value = serde_json::from_str(&changed).unwrap();
        assert!(changed_value["state"]["channel"]["rooms"][0]
            .get("icon")
            .is_some());
        assert_eq!(changed_value["state"]["channel"]["icon"], "star");
        decoder.decode(&changed).unwrap();
        state.channel.rooms[0].icon = "couch".to_owned().try_into().unwrap();
        let cleared = encoder
            .encode(&Event::State {
                state: state.clone(),
            })
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&cleared).unwrap()["state"]["channel"]["rooms"][0]
                ["icon"],
            "couch"
        );
        decoder.decode(&cleared).unwrap();
        state.users.clear();
        state.channel.rooms.clear();
        decoder
            .decode(&encoder.encode(&Event::State { state }).unwrap())
            .unwrap();
        assert!(decoder.0.rooms.is_empty());
        assert_eq!(
            decoder.decode(&compact).err(),
            Some("missing_identity_image")
        );
        // A new Welcome is complete even when sender and receiver objects are reused.
        decoder.decode(&encoder.encode(&greeting).unwrap()).unwrap();
        let mut invalid_welcome: Value = serde_json::from_str(&compact).unwrap();
        invalid_welcome["type"] = json!("welcome");
        assert_eq!(
            decoder.decode(&invalid_welcome.to_string()).err(),
            Some("missing_identity_image")
        );
    }
}
