use super::*;

#[test]
fn source_session_owns_limit_across_updates_and_transfer() {
    let id = Uuid::from_u128;
    let (mut room, mut endpoints) = screen_on_room_base();
    let source = id(3);
    let target = id(4);
    let screen = id(10);
    let member = endpoints[&source].member;
    endpoints.get_mut(&target).unwrap().member = member;
    assert_eq!(
        room.set_screen_direct_limit(target, screen, Some(1)),
        Err("not_publication_owner")
    );
    for invalid in [0, crate::MAX_RELAY_CAPACITY + 1] {
        assert_eq!(
            room.set_screen_direct_limit(source, screen, Some(invalid)),
            Err("invalid_relay_capacity")
        );
    }
    room.set_screen_direct_limit(source, screen, Some(1))
        .unwrap();
    room.publish(
        member,
        source,
        screen,
        Kind::Screen,
        screen_settings(),
        Some(Default::default()),
    )
    .unwrap();
    room.transfer_source(member, source, screen, target, &endpoints)
        .unwrap();
    let snapshot = serde_json::to_value(room.publication(screen).unwrap()).unwrap();
    assert_eq!(snapshot["directLimit"], 1);
    assert_eq!(
        room.set_screen_direct_limit(source, screen, None),
        Err("not_publication_owner")
    );
    room.set_screen_direct_limit(target, screen, None).unwrap();
    assert!(serde_json::to_value(room.publication(screen).unwrap())
        .unwrap()
        .get("directLimit")
        .is_none());
    room.unpublish(target, screen).unwrap();
    assert_eq!(
        room.set_screen_direct_limit(target, screen, Some(1)),
        Err("publication_unavailable")
    );
}

#[test]
fn source_direct_limit_replans_live_outputs() {
    let id = Uuid::from_u128;
    let (prior, endpoints) = screen_on_room_base();
    let mut room = RoomRuntime::new(prior.policy.clone());
    let source = id(3);
    let screen = id(10);
    room.set_host_session(source);
    room.set_default_relay_capacity(1);
    room.set_relay_capacity(endpoints[&source].member, source, Some(2))
        .unwrap();
    room.publish(
        endpoints[&source].member,
        source,
        screen,
        Kind::Screen,
        screen_settings(),
        Some(Default::default()),
    )
    .unwrap();
    for viewer in [id(1), id(2), id(4)] {
        room.set_relay_capacity(endpoints[&viewer].member, viewer, Some(0))
            .unwrap();
        room.subscribe(endpoints[&viewer].member, viewer, screen, true, None)
            .unwrap();
    }
    let direct = |room: &RoomRuntime| {
        room.flows()
            .filter(|flow| flow.publication_id == screen && flow.sender == source && flow.selected)
            .count()
    };
    let pairs = confirmed_pairs(&[(1, 3), (2, 3), (3, 4)]);
    room.reconcile_with_pairs(&endpoints, 0, &pairs);
    assert_eq!(direct(&room), 1);
    let incumbent = room
        .flows()
        .find(|flow| flow.publication_id == screen)
        .unwrap()
        .clone();
    room.flow_state(
        incumbent.id,
        incumbent.receiver,
        source,
        FlowState::Decoded,
        0,
    )
    .unwrap();
    let transition = crate::publication::SCREEN_PREPARE_MS;
    for (now, limit, expected) in [(1, Some(3), 3), (2, Some(2), 2), (3 + transition, None, 1)] {
        room.set_screen_direct_limit(source, screen, limit).unwrap();
        room.reconcile_with_pairs(&endpoints, now, &pairs);
        if now >= 2 {
            room.expire_media(now + crate::publication::SCREEN_PREPARE_MS);
            room.reconcile_with_pairs(
                &endpoints,
                now + crate::publication::SCREEN_PREPARE_MS,
                &pairs,
            );
        }
        assert_eq!(direct(&room), expected);
        if now == 1 {
            assert!(room
                .flows()
                .any(|flow| flow.id == incumbent.id && flow.selected));
        }
    }
}
