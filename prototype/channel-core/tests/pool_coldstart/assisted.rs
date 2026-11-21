use super::*;

fn endpoint(net: &mut RoomNetwork, socket: Uuid, credential: Option<&str>) -> (Uuid, String) {
    net.command(
        socket,
        json!({"type":"join","name":"Viewer","credential":credential}),
    )
    .events
    .into_iter()
    .find_map(|(_, event)| match event {
        Event::Welcome {
            session_id,
            credential,
            ..
        } => Some((session_id, credential)),
        _ => None,
    })
    .unwrap()
}

#[test]
fn first_assisted_subscription_connects_both_legs_and_returns_to_ordinary_viewing() {
    let mut net = RoomNetwork::new();
    let [owner, browser, native] = [(); 3].map(|_| Uuid::new_v4());
    let source = join(&mut net, owner, "Source");
    let (viewer, credential) = endpoint(&mut net, browser, None);
    let (helper, _) = endpoint(&mut net, native, Some(&credential));
    let room = net.create(owner, RoomAccess::Public, false);
    let screen = publish_screen(&mut net, owner, &room);
    for socket in [owner, browser, native] {
        assert!(net.state(socket).pairs.is_empty());
    }
    command(
        &mut net,
        browser,
        json!({"type":"subscribe","publicationId":screen,"enabled":true,"helperSessionId":helper}),
    );
    let mut confirmed = std::collections::BTreeSet::new();
    for _ in 0..2 {
        let trial = net
            .state(native)
            .pairs
            .iter()
            .find(|p| !confirmed.contains(&p.id))
            .expect("a requested leg has been admitted");
        let id = trial.id;
        let peer = match trial.peer_id {
            p if p == source => owner,
            p if p == viewer => browser,
            _ => panic!("unexpected assisted peer"),
        };
        confirmed.insert(id);
        link_connected(&mut net, native, id);
        link_connected(&mut net, peer, id);
    }
    let receive = pair(&net, native, source);
    let upstream = input(receive, screen).expect("helper receives the screen");
    let receive_id = receive.id;
    let display = pair(&net, browser, helper);
    let local = input(display, screen).expect("browser receives through its helper");
    assert_eq!(local.input_flow_id, Some(upstream.id));
    let display_id = display.id;
    command(
        &mut net,
        native,
        json!({"type":"flow_state","pairId":receive_id,"flowId":upstream.id,"state":"forwardable"}),
    );
    command(
        &mut net,
        browser,
        json!({"type":"flow_state","pairId":display_id,"flowId":local.id,"state":"decoded"}),
    );
    assert!(net.state(native).subscriptions.is_empty());
    assert!(net.state(browser).subscriptions.contains(&screen));

    command(&mut net, browser, subscribe(screen, true));
    let direct = pair(&net, browser, source).id;
    link_connected(&mut net, owner, direct);
    link_connected(&mut net, browser, direct);
    let ordinary = input(pair(&net, browser, source), screen).expect("ordinary viewing resumes");
    command(
        &mut net,
        browser,
        json!({"type":"flow_state","pairId":direct,"flowId":ordinary.id,"state":"decoded"}),
    );
    command(
        &mut net,
        browser,
        json!({"type":"flow_state","pairId":direct,"flowId":ordinary.id,"state":"switch_ready"}),
    );
    assert!(input(pair(&net, browser, source), screen).unwrap().selected);
    assert!(net.state(browser).failed_subscriptions.is_empty());
}
