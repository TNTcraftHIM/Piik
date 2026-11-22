use super::*;
use axum::body::{to_bytes, Body};
use tower::ServiceExt;

const ORIGIN: &str = "https://approved.example";
const HOST: &str = "127.0.0.1:39721";

fn fixture() -> (
    tempfile::TempDir,
    Router,
    Arc<Permit>,
    watch::Sender<Option<piik_channel_core::wire::Snapshot>>,
    mpsc::Receiver<Request>,
) {
    let directory = tempfile::tempdir().unwrap();
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
        port: 39721,
        token: "fixture".into(),
        registry: Mutex::new(Registry {
            sites: sites::Sites::open(directory.path()).unwrap(),
            approvals: BTreeMap::from([(ORIGIN.into(), Arc::new(Permission::new(Uuid::new_v4())))]),
            hosts: BTreeMap::new(),
            local: None,
        }),
        closing: watch::channel(false).0,
        launch: Mutex::new(None),
        desktop: Desktop::new().unwrap(),
        external_inputs: Inputs::default(),
        capture_targets: Default::default(),
        capture_microphones: Default::default(),
        update: update::Owner::disabled(),
    });
    let binding = Uuid::new_v4();
    let state = serde_json::from_value(json!({
        "channel":{"id":Uuid::new_v4(),"name":"Fixture","icon":"couch","ownerId":null,"userCount":1,"historyWindow":100,
            "hostingMode":"lightweight","roomCreationPolicy":"ordinary","managedRoomIds":[],
            "rooms":[{"id":"room","name":"Room","icon":"couch","creatorId":Uuid::new_v4(),"access":"private","hidden":false,
                "hasPassword":false,"voiceBitrate":64000,"relayOverride":null,"authorized":true,"canManage":false,"available":true,"reading":false,
                "lastMessageSeq":0,"participantSessionIds":[],"fileActivity":[],"capabilities":{"attachments":true},
                "delivery":{"hostSessionId":Uuid::new_v4(),"bindingId":binding}}]},
        "files":[],"users":[],"sessions":[],"publications":[],"voice":[],"subscriptions":[],"failedSubscriptions":[],"pairs":[],"iceServers":[],
        "watchActivities":[],"watchSubscriptions":[],"watchBytes":[]
    })).unwrap();
    let (snapshot, observed) = watch::channel(Some(state));
    let (requests, incoming) = mpsc::channel(8);
    let publication = Uuid::new_v4();
    let permit = app.external_inputs.permit(
        publication,
        "room".into(),
        requests,
        piik_channel_native::peer::InputAuthority {
            scope: piik_channel_native::peer::CaptureScope {
                publication_id: publication,
                room_id: "room".into(),
                binding_id: binding,
            },
            snapshot: observed,
        },
    );
    let router = routes()
        .route("/health", get(health))
        .layer(middleware::from_fn_with_state(app.clone(), access))
        .with_state(app);
    (directory, router, permit, snapshot, incoming)
}

async fn call(
    router: &Router,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> Response {
    let mut request = HttpRequest::builder()
        .method(method)
        .uri(path)
        .header(header::HOST, HOST)
        .body(Body::from(body.to_owned()))
        .unwrap();
    for (name, value) in headers {
        request.headers_mut().insert(
            axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
            value.parse().unwrap(),
        );
    }
    tokio::time::timeout(Duration::from_secs(2), router.clone().oneshot(request))
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn metadata_keeps_bearer_and_current_page_authority() {
    let (_directory, router, permit, snapshot, mut requests) = fixture();
    let endpoint = format!("/whip/{}", permit.id);
    let generation = Uuid::new_v4();
    let session = format!("{endpoint}/{generation}");
    let bearer = format!("Bearer {}", permit.token);
    for method in ["GET", "HEAD", "OPTIONS"] {
        let response = call(
            &router,
            method,
            &endpoint,
            &[("authorization", &bearer)],
            "",
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["accept-post"], "application/sdp");
        assert!(to_bytes(response.into_body(), 0).await.unwrap().is_empty());
        for path in [&endpoint, &session] {
            assert_eq!(
                call(&router, method, path, &[], "").await.status(),
                StatusCode::UNAUTHORIZED
            );
            assert_eq!(
                call(
                    &router,
                    method,
                    path,
                    &[("authorization", "Bearer wrong")],
                    ""
                )
                .await
                .status(),
                StatusCode::UNAUTHORIZED
            );
        }
    }
    for method in ["GET", "OPTIONS"] {
        let headers = [("authorization", bearer.as_str())];
        let request = call(&router, method, &session, &headers, "");
        let inspect = async {
            let Request::Inspect {
                permit: current,
                generation: resource,
                response,
            } = requests.recv().await.unwrap()
            else {
                panic!("metadata changed the input")
            };
            assert!(Arc::ptr_eq(&current, &permit));
            assert_eq!(resource, generation);
            response.send(Ok(())).unwrap();
        };
        let (response, ()) = tokio::join!(request, inspect);
        assert_eq!(response.status(), StatusCode::OK);
        assert!(to_bytes(response.into_body(), 0).await.unwrap().is_empty());
    }
    let headers = [("authorization", bearer.as_str())];
    let request = call(&router, "GET", &session, &headers, "");
    let missing = async {
        let Request::Inspect { response, .. } = requests.recv().await.unwrap() else {
            panic!("metadata changed the input")
        };
        response.send(Err(StatusCode::NOT_FOUND)).unwrap();
    };
    let (response, ()) = tokio::join!(request, missing);
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert!(requests.try_recv().is_err());
    snapshot.send_replace(None);
    for path in [&endpoint, &session] {
        assert_eq!(
            call(&router, "GET", path, &headers, "").await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn preflight_describes_only_approved_origin_methods_without_granting_a_permit() {
    let (_directory, router, permit, _snapshot, mut requests) = fixture();
    let endpoint = format!("/whip/{}", permit.id);
    let session = format!("{endpoint}/{}", Uuid::new_v4());
    let bearer = format!("Bearer {}", permit.token);
    for (path, method, methods) in [
        (&endpoint, "POST", "GET, HEAD, POST, OPTIONS"),
        (&session, "DELETE", "GET, HEAD, DELETE, OPTIONS"),
    ] {
        let headers = [
            ("origin", ORIGIN),
            ("access-control-request-method", method),
            (
                "access-control-request-headers",
                "authorization,content-type",
            ),
            ("access-control-request-private-network", "true"),
        ];
        let response = call(&router, "OPTIONS", path, &headers, "").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            ORIGIN
        );
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_METHODS],
            methods
        );
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS],
            "Authorization, Content-Type"
        );
        assert_eq!(
            response.headers()["access-control-allow-private-network"],
            "true"
        );
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert!(!response.headers().contains_key(header::AUTHORIZATION));
        assert!(!response
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS));
        assert!(to_bytes(response.into_body(), 0).await.unwrap().is_empty());
        assert_eq!(
            call(&router, method, path, &[("origin", ORIGIN)], "")
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        for origin in ["https://unapproved.example", "null"] {
            let denied = call(
                &router,
                "OPTIONS",
                path,
                &[
                    ("origin", origin),
                    ("access-control-request-method", method),
                ],
                "",
            )
            .await;
            assert_eq!(denied.status(), StatusCode::FORBIDDEN);
            assert!(!denied
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
            assert_eq!(
                call(
                    &router,
                    method,
                    path,
                    &[("origin", origin), ("authorization", &bearer)],
                    ""
                )
                .await
                .status(),
                StatusCode::FORBIDDEN
            );
        }
    }
    assert!(
        requests.try_recv().is_err(),
        "preflights must not enter the page's operation queue"
    );
    let denied = call(
        &router,
        "OPTIONS",
        &endpoint,
        &[
            ("host", "remote.example"),
            ("origin", ORIGIN),
            ("access-control-request-method", "POST"),
        ],
        "",
    )
    .await;
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    let health = call(
        &router,
        "OPTIONS",
        "/health",
        &[
            ("origin", ORIGIN),
            ("access-control-request-method", "POST"),
        ],
        "",
    )
    .await;
    assert_eq!(health.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        health.headers()[header::ACCESS_CONTROL_ALLOW_METHODS],
        "GET"
    );
    let unsupported = call(
        &router,
        "OPTIONS",
        &endpoint,
        &[
            ("origin", ORIGIN),
            ("access-control-request-method", "PATCH"),
            ("access-control-request-headers", "X-Arbitrary"),
        ],
        "",
    )
    .await;
    assert!(!unsupported.headers()[header::ACCESS_CONTROL_ALLOW_METHODS]
        .to_str()
        .unwrap()
        .contains("PATCH"));
    assert!(!unsupported.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS]
        .to_str()
        .unwrap()
        .contains("X-Arbitrary"));
    permit.revoke();
    assert_eq!(
        call(
            &router,
            "GET",
            &endpoint,
            &[("origin", ORIGIN), ("authorization", &bearer)],
            ""
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn post_and_delete_keep_existing_authenticated_page_requests_and_expose_only_location() {
    let (_directory, router, permit, _snapshot, mut requests) = fixture();
    let endpoint = format!("/whip/{}", permit.id);
    let generation = Uuid::new_v4();
    let session = format!("{endpoint}/{generation}");
    let bearer = format!("bearer  {}", permit.token);
    let headers = [
        ("origin", ORIGIN),
        ("authorization", bearer.as_str()),
        ("content-type", "Application/SDP"),
    ];
    let unsupported = call(
        &router,
        "POST",
        &endpoint,
        &[("authorization", &bearer), ("content-type", "text/plain")],
        "fixture SDP",
    )
    .await;
    assert_eq!(unsupported.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let request = call(&router, "POST", &endpoint, &headers, "fixture SDP");
    let offer = async {
        let Request::Offer {
            permit: current,
            offer,
            response,
        } = requests.recv().await.unwrap()
        else {
            panic!("expected offer")
        };
        assert!(Arc::ptr_eq(&current, &permit));
        assert_eq!(offer, "fixture SDP");
        response
            .send(Ok((generation, "fixture answer".into())))
            .unwrap();
    };
    let (response, ()) = tokio::join!(request, offer);
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(response.headers()[header::LOCATION], session);
    assert_eq!(
        response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
        ORIGIN
    );
    assert_eq!(
        response.headers()[header::ACCESS_CONTROL_EXPOSE_HEADERS],
        "Location"
    );
    assert_eq!(
        to_bytes(response.into_body(), 100).await.unwrap(),
        "fixture answer"
    );
    let request = call(&router, "DELETE", &session, &headers, "");
    let delete = async {
        let Request::Delete {
            permit: current,
            generation: resource,
            response,
        } = requests.recv().await.unwrap()
        else {
            panic!("expected delete")
        };
        assert!(Arc::ptr_eq(&current, &permit));
        assert_eq!(resource, generation);
        response.send(Ok(())).unwrap();
    };
    let (response, ()) = tokio::join!(request, delete);
    assert_eq!(response.status(), StatusCode::OK);
    assert!(to_bytes(response.into_body(), 0).await.unwrap().is_empty());
    assert!(!permit.stopped());
    assert!(requests.try_recv().is_err());
}
