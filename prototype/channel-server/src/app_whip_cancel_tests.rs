use super::*;
use anyhow::ensure;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message as WsMessage},
    MaybeTlsStream, WebSocketStream,
};

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

async fn replies(socket: &mut Socket, ids: &[&str]) -> Vec<Value> {
    timeout(Duration::from_secs(3), async {
        let mut replies = Vec::<Value>::new();
        while ids
            .iter()
            .any(|id| !replies.iter().any(|reply| reply["id"] == *id))
        {
            let value = socket.next().await.unwrap().unwrap().into_text().unwrap();
            replies.push(serde_json::from_str(&value).unwrap());
        }
        replies
    })
    .await
    .unwrap()
}

fn reply<'a>(replies: &'a [Value], id: &str) -> &'a Value {
    replies.iter().find(|reply| reply["id"] == id).unwrap()
}

#[tokio::test]
async fn native_and_external_cancellation_keep_the_other_preparation_owner() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let site = "https://owned.test".to_owned();
    let channel = Uuid::new_v4();
    let user = Uuid::new_v4();
    let publication = Uuid::new_v4();
    let binding = Uuid::new_v4();
    let state: piik_channel_core::wire::Snapshot = serde_json::from_value(json!({
        "channel":{"id":channel,"name":"Owned fixture","icon":"couch","ownerId":null,"userCount":1,"historyWindow":100,
            "rooms":[{"id":"room","name":"Room","icon":"couch","creatorId":user,"access":"private","hidden":false,
                "hasPassword":false,"voiceBitrate":64000,"relayOverride":null,"authorized":true,"canManage":false,"available":true,"reading":false,
                "lastMessageSeq":0,"participantSessionIds":[],"realtimeSessionIds":[],"capabilities":{"attachments":true},
                "delivery":{"hostSessionId":Uuid::new_v4(),"bindingId":binding,"nextHops":{}}}]},
        "files":[],"users":[],"sessions":[],"publications":[],"voice":[],"subscriptions":[],"failedSubscriptions":[],"pairs":[],"iceServers":[],
        "watchActivities":[],"watchSubscriptions":[],"watchBytes":[]
    }))?;
    let (_snapshot, observed) = watch::channel(Some(state));
    let authority = piik_channel_native::peer::InputAuthority {
        scope: piik_channel_native::peer::CaptureScope {
            publication_id: publication,
            room_id: "room".into(),
            binding_id: binding,
        },
        snapshot: observed,
    };
    let (commands, mut requests) = mpsc::channel(8);
    let (stop, mut stopped) = watch::channel(false);
    let host = Host {
        credential: "owned".into(),
        commands,
        ready: watch::channel(Some(Ok(()))).1,
        stop,
        task: tokio::spawn(async move {
            let _ = stopped.wait_for(|stopped| *stopped).await;
            Ok(())
        }),
    };
    let mut sites = sites::Sites::open(directory.path())?;
    let permission = Arc::new(Permission::new(sites.approve(&site, true)?));
    let app = Arc::new(App {
        config: Config {
            data_root: directory.path().into(),
            assets: directory.path().into(),
            open_browser: false,
            terminal_notice: None,
            page_player: None,
            website_permission_reset: None,
            window_navigation: None,
            cloudflared: PathBuf::new(),
            ice_servers: vec![],
            update: Default::default(),
        },
        port: address.port(),
        token: "owned".into(),
        registry: Mutex::new(Registry {
            sites,
            approvals: BTreeMap::from([(site.clone(), permission)]),
            hosts: BTreeMap::from([((site.clone(), channel, user), host)]),
            local: None,
        }),
        closing: watch::channel(false).0,
        launch: Mutex::new(None),
        desktop: Desktop::new()?,
        external_inputs: Inputs::default(),
        update: update::Owner::disabled(),
    });
    let router = Router::new()
        .route("/rooms", get(upgrade))
        .with_state(app.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await });
    let result = async {
        let mut request = format!("ws://{address}/rooms").into_client_request()?;
        request.headers_mut().insert("Origin", site.parse()?);
        request.headers_mut().insert("Sec-WebSocket-Protocol", "piik-channel-rooms.owned".parse()?);
        let (mut socket, _) = connect_async(request).await?;
        macro_rules! send {
            ($value:expr) => { socket.send(WsMessage::Text($value.to_string().into())).await? };
        }
        send!(json!({"id":"hello","type":"hello","channelId":channel,"userId":user,"credential":"owned","name":"Owned"}));
        ensure!(reply(&replies(&mut socket, &["hello"]).await, "hello")["error"].is_null());

        send!(json!({"id":"arm","type":"prepare_external_input","publicationId":publication,"roomId":"room"}));
        let HostCommand::AuthorizeInput { result, .. } = timeout(Duration::from_secs(3), requests.recv()).await?.unwrap() else { panic!("expected input authorization") };
        assert!(result.send(Ok(authority.clone())).is_ok());
        let armed = replies(&mut socket, &["arm"]).await;
        let descriptor = &reply(&armed, "arm")["result"];
        let endpoint = url::Url::parse(descriptor["endpoint"].as_str().unwrap())?;
        let permit = Uuid::parse_str(endpoint.path_segments().unwrap().next_back().unwrap())?;
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, format!("Bearer {}", descriptor["token"].as_str().unwrap()).parse()?);
        headers.insert(header::CONTENT_TYPE, "application/sdp".parse()?);
        ensure!(app.external_inputs.authorized(permit, &headers).is_some());
        let capture = |id| json!({"id":id,"type":"prepare_capture","publicationId":publication,"roomId":"room",
            "target":{"kind":"display","sourceId":"owned","title":"Owned fixture"},
            "settings":{"width":1280,"height":720,"fps":24,"bitrate":2_500_000,"degradationPreference":"balanced"},
            "codecMode":"vp8","encodingExecution":"software","audio":false});

        // This is the reported sibling path: the armed OBS input precedes Native B.
        send!(capture("native-b"));
        let HostCommand::PrepareCapture(native_b) = timeout(Duration::from_secs(3), requests.recv()).await?.unwrap() else { panic!("expected Native capture preparation") };
        send!(json!({"id":"cancel-b","type":"cancel_capture","publicationId":publication}));
        let cancelled = replies(&mut socket, &["native-b", "cancel-b"]).await;
        ensure!(reply(&cancelled, "native-b")["error"] == "capture_cancelled");
        ensure!(reply(&cancelled, "cancel-b")["error"].is_null());
        ensure!(native_b.result.is_closed());
        ensure!(app.external_inputs.authorized(permit, &headers).is_some(), "cancelling Native B revoked the already-armed OBS input A");
        ensure!(!cancelled.iter().any(|event| event["type"] == "external_input_state"));

        // The reverse direction must retire OBS A without cancelling a newer Native B.
        send!(capture("native-next"));
        let HostCommand::PrepareCapture(native_next) = timeout(Duration::from_secs(3), requests.recv()).await?.unwrap() else { panic!("expected Native capture preparation") };
        send!(json!({"id":"cancel-obs","type":"cancel_external_input","publicationId":publication}));
        let cancelled = replies(&mut socket, &["cancel-obs"]).await;
        ensure!(reply(&cancelled, "cancel-obs")["error"].is_null());
        ensure!(cancelled.iter().any(|event| event["type"] == "external_input_state" && event["state"] == "closed"));
        ensure!(!native_next.result.is_closed(), "OBS cancellation stopped the Native candidate");
        ensure!(app.external_inputs.authorized(permit, &headers).is_none());
        ensure!(offer(State(app.clone()), Path(permit), headers.clone(), "owned-offer".into()).await.status() == StatusCode::UNAUTHORIZED);
        send!(json!({"id":"cleanup-native","type":"cancel_capture","publicationId":publication}));
        let cancelled = replies(&mut socket, &["native-next", "cleanup-native"]).await;
        ensure!(reply(&cancelled, "native-next")["error"] == "capture_cancelled");
        ensure!(native_next.result.is_closed());

        // The explicit operation also cancels authorization before a permit exists.
        send!(json!({"id":"early-obs","type":"prepare_external_input","publicationId":publication,"roomId":"room"}));
        let HostCommand::AuthorizeInput { result, .. } = timeout(Duration::from_secs(3), requests.recv()).await?.unwrap() else { panic!("expected input authorization") };
        send!(json!({"id":"cancel-early","type":"cancel_external_input","publicationId":publication}));
        let cancelled = replies(&mut socket, &["early-obs", "cancel-early"]).await;
        ensure!(reply(&cancelled, "early-obs")["error"] == "capture_cancelled");
        ensure!(reply(&cancelled, "cancel-early")["error"].is_null());
        ensure!(result.is_closed());
        socket.close(None).await?;
        Ok::<_, anyhow::Error>(())
    }.await;
    app.shutdown().await;
    server.abort();
    let _ = server.await;
    result
}
