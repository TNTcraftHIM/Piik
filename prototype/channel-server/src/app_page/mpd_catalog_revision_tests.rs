// Include as a child module of mpd_selection_tests.rs to reuse its clear owned MPD and selection helper.
use super::*;

#[derive(Clone, Debug, PartialEq, Eq)]
struct RevisionRequest {
    uri: String,
    cookie: String,
    range: Option<String>,
}
struct RevisionOrigin {
    version: AtomicUsize,
    requests: Mutex<Vec<RevisionRequest>>,
}
async fn revision_origin(
    State(facts): State<Arc<RevisionOrigin>>,
    request: Request,
) -> Response<Body> {
    let uri = request.uri().to_string();
    let cookie = request.headers()["cookie"].to_str().unwrap().to_owned();
    let range = request
        .headers()
        .get("range")
        .map(|v| v.to_str().unwrap().to_owned());
    facts.requests.lock().unwrap().push(RevisionRequest {
        uri: uri.clone(),
        cookie,
        range: range.clone(),
    });
    if request.uri().path() == "/entry.mpd" {
        return Response::builder()
            .status(307)
            .header("location", "/resolved/manifest.mpd?catalog=stable")
            .body(Body::empty())
            .unwrap();
    }
    if request.uri().path() == "/resolved/manifest.mpd" {
        let version = facts.version.load(Ordering::SeqCst);
        let xml = CLEAR_MPD
            .replace(
                "<Period duration=",
                "<BaseURL>assets/</BaseURL><Period duration=",
            )
            .replace(
                "selected-video.mp4",
                &format!("selected-video.mp4?revision={version}&amp;sig=owned%2Fvideo"),
            )
            .replace(
                "selected-audio.mp4",
                &format!("selected-audio.mp4?revision={version}&amp;sig=owned%2Faudio"),
            );
        return Response::builder()
            .header("content-type", "application/dash+xml")
            .body(Body::from(xml))
            .unwrap();
    }
    assert!(uri.starts_with("/resolved/assets/selected-"));
    let version: u8 = if uri.contains("revision=0&sig=") {
        0
    } else {
        assert!(uri.contains("revision=1&sig="));
        1
    };
    assert_eq!(
        request.headers()["cookie"],
        format!("OwnedRevision={version}").as_str()
    );
    assert_eq!(range.as_deref(), Some("bytes=32-63"));
    Response::builder()
        .status(206)
        .header("content-range", "bytes 32-63/128")
        .header("content-length", 32)
        .header("content-type", "video/mp4")
        .body(Body::from(vec![version; 32]))
        .unwrap()
}

async fn admitted_ids(connection: &Arc<Connection>, page: Uuid, source: Uuid) -> Result<Vec<Uuid>> {
    let reply = connection
        .read_resource(page, source, source, Uuid::new_v4(), 0, 65536)?
        .await?;
    let xml =
        String::from_utf8(Base64::decode_vec(reply["bytesBase64"].as_str().unwrap()).unwrap())?;
    assert!(!xml.contains("sig="));
    assert!(!xml.contains("127.0.0.1"));
    assert!(xml.contains("indexRange=\"32-63\""));
    let ids = xml
        .split("<BaseURL>")
        .skip(1)
        .map(|part| Uuid::parse_str(part.split("</BaseURL>").next().unwrap()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(ids.len(), 2);
    Ok(ids)
}

#[tokio::test]
async fn same_manifest_url_new_revision_preserves_each_selected_resource_query_and_context(
) -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let facts = Arc::new(RevisionOrigin {
        version: AtomicUsize::new(0),
        requests: Mutex::new(Vec::new()),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/entry.mpd?catalog=stable", listener.local_addr()?);
    let router = Router::new()
        .route("/{*path}", get(revision_origin))
        .with_state(facts.clone());
    let (shutdown, stopped) = oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let (_page_lifetime, retired) = watch::channel(false);
    let page = Uuid::new_v4();
    let candidate_page = Uuid::new_v4();
    let choice = Uuid::new_v4();
    let (events, _events) = mpsc::channel(8);
    let context_version = facts.clone();
    let connection = Arc::new(Connection::new(
        Some(Arc::new(move |command| {
            match command {
                Command::Media {
                    page_id,
                    choice_id,
                    reply,
                    ..
                } => {
                    assert!(page_id == page || page_id == candidate_page);
                    assert_eq!(choice_id, choice);
                    let version = context_version.version.load(Ordering::SeqCst);
                    let cookie = format!("OwnedRevision={version}");
                    let _ = reply.send(Ok(MediaContext {
                        url: url.clone(),
                        request: None,
                        format: Format::Dash,
                        size: None,
                        retired: retired.clone(),
                        cookies: Arc::new(move |_| {
                            let cookie = cookie.clone();
                            Box::pin(async move { Ok(Some(cookie)) })
                        }),
                    }));
                }
                Command::Retire { .. } => {}
                _ => panic!("unexpected native command"),
            }
            true
        })),
        events,
    ));
    let (host, mut commands) = mpsc::channel(8);
    let session = Uuid::new_v4();
    let (_provider_lifetime, provider_retired) = watch::channel(false);
    let host_task = tokio::spawn(async move {
        while let Some(command) = commands.recv().await {
            match command {
                HostCommand::RegisterWatchReader { result, .. } => {
                    let _ =
                        result.send(Ok(piik_channel_native::session::WatchReaderRegistration {
                            session_id: session,
                            retired: provider_retired.clone(),
                        }));
                }
                HostCommand::RevokeWatchReader { .. } => {}
                _ => panic!("unexpected host command"),
            }
        }
    });
    let a = connection
        .inspect_mpd(page, choice, Uuid::new_v4())?
        .await?;
    let (source_a, video_a, audio_a) = selection(&a);
    connection
        .prepare_mpd_media(page, source_a, video_a, Some(audio_a), host.clone())?
        .await?;
    let ids_a = admitted_ids(&connection, page, source_a).await?;
    facts.version.store(1, Ordering::SeqCst);
    let b = connection
        .inspect_mpd(candidate_page, choice, Uuid::new_v4())?
        .await?;
    let (source_b, video_b, audio_b) = selection(&b);
    assert_ne!(source_a, source_b);
    assert!(
        matches!(connection.prepare_mpd_media(candidate_page, source_b, video_a, Some(audio_b), host.clone()), Err(e) if e.to_string() == "watch_source_changed")
    );
    // Old active grant reads its captured revision even after same-URL inspection returned a new body.
    for resource in &ids_a {
        let result = connection
            .read_resource(page, source_a, *resource, Uuid::new_v4(), 32, 32)?
            .await?;
        assert_eq!(
            Base64::decode_vec(result["bytesBase64"].as_str().unwrap()).unwrap(),
            vec![0; 32]
        );
    }
    connection
        .prepare_mpd_media(
            candidate_page,
            source_b,
            video_b,
            Some(audio_b),
            host.clone(),
        )?
        .await?;
    let ids_b = admitted_ids(&connection, candidate_page, source_b).await?;
    assert!(ids_a.iter().all(|id| !ids_b.contains(id)));
    let before = facts.requests.lock().unwrap().len();
    assert!(connection
        .read_resource(candidate_page, source_b, ids_a[0], Uuid::new_v4(), 32, 32)?
        .await
        .is_err());
    assert_eq!(facts.requests.lock().unwrap().len(), before);
    for resource in &ids_b {
        let result = connection
            .read_resource(candidate_page, source_b, *resource, Uuid::new_v4(), 32, 32)?
            .await?;
        assert_eq!(
            Base64::decode_vec(result["bytesBase64"].as_str().unwrap()).unwrap(),
            vec![1; 32]
        );
    }
    // Native preparation does not retire another Page. Session commit explicitly retires the predecessor.
    assert_eq!(connection.media_source(page).unwrap().resource_id, source_a);
    assert_eq!(
        connection.media_source(candidate_page).unwrap().resource_id,
        source_b
    );
    assert_eq!(admitted_ids(&connection, page, source_a).await?, ids_a);
    connection.stop_media(page);
    assert!(
        matches!(connection.read_resource(page, source_a, ids_a[0], Uuid::new_v4(), 32, 32), Err(e) if e.to_string() == "watch_source_retired")
    );
    assert_eq!(
        admitted_ids(&connection, candidate_page, source_b).await?,
        ids_b
    );
    let requests = facts.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 8); // two original URLs, two redirects, four explicitly requested ranges
    assert_eq!(
        &requests[..4],
        &[
            RevisionRequest {
                uri: "/entry.mpd?catalog=stable".into(),
                cookie: "OwnedRevision=0".into(),
                range: None
            },
            RevisionRequest {
                uri: "/resolved/manifest.mpd?catalog=stable".into(),
                cookie: "OwnedRevision=0".into(),
                range: None
            },
            RevisionRequest {
                uri: "/entry.mpd?catalog=stable".into(),
                cookie: "OwnedRevision=1".into(),
                range: None
            },
            RevisionRequest {
                uri: "/resolved/manifest.mpd?catalog=stable".into(),
                cookie: "OwnedRevision=1".into(),
                range: None
            },
        ]
    );
    for (version, reads) in requests[4..].chunks(2).enumerate() {
        let actual: std::collections::BTreeSet<_> = reads.iter().map(|r| r.uri.clone()).collect();
        let expected = [
            format!("/resolved/assets/selected-video.mp4?revision={version}&sig=owned%2Fvideo"),
            format!("/resolved/assets/selected-audio.mp4?revision={version}&sig=owned%2Faudio"),
        ]
        .into_iter()
        .collect();
        assert_eq!(actual, expected);
    }
    connection.stop_media(candidate_page);
    drop(connection);
    drop(host);
    host_task.abort();
    let _ = host_task.await;
    let _ = shutdown.send(());
    server.await?;
    Ok(())
}
