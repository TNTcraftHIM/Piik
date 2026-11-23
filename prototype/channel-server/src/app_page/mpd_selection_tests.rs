use super::*;
use axum::{
    body::Body,
    extract::{Request, State},
    http::Response,
    routing::get,
    Router,
};
use base64ct::{Base64, Encoding};
use std::sync::atomic::{AtomicUsize, Ordering};

#[path = "mpd_inspection_worker_tests.rs"]
pub(crate) mod worker_retirement;

// Owned clear SegmentBase input. No encrypted fixture is modified or admitted.
const CLEAR_MPD: &str = r#"<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT6S" minBufferTime="PT1S"><Period duration="PT6S"><AdaptationSet mimeType="video/mp4" contentType="video"><Representation id="same-video" bandwidth="100000" width="320" height="180" codecs="avc1.42c01e"><BaseURL>selected-video.mp4</BaseURL><SegmentBase indexRange="32-63"><Initialization range="0-31"/></SegmentBase></Representation><Representation id="unused-video" bandwidth="200000" width="640" height="360" codecs="avc1.42c01e"><BaseURL>unused-video.mp4</BaseURL><SegmentBase indexRange="32-63"><Initialization range="0-31"/></SegmentBase></Representation></AdaptationSet><AdaptationSet mimeType="audio/mp4" contentType="audio" lang="en"><Representation id="same-audio" bandwidth="64000" codecs="mp4a.40.2" audioSamplingRate="48000"><BaseURL>selected-audio.mp4</BaseURL><SegmentBase indexRange="32-63"><Initialization range="0-31"/></SegmentBase></Representation></AdaptationSet></Period></MPD>"#;

async fn owned_manifest(
    State(paths): State<Arc<Mutex<Vec<String>>>>,
    request: Request,
) -> Response<Body> {
    paths.lock().unwrap().push(request.uri().path().to_owned());
    if request.uri().path().ends_with(".mpd") {
        Response::builder()
            .header("content-type", "application/dash+xml")
            .body(Body::from(CLEAR_MPD))
            .unwrap()
    } else {
        panic!(
            "inspect/prepare must not fetch unrequested media: {}",
            request.uri().path()
        );
    }
}

fn selection(catalog: &Value) -> (Uuid, Uuid, Uuid) {
    let tracks = catalog["tracks"].as_array().unwrap();
    let id = |kind| {
        Uuid::parse_str(
            tracks.iter().find(|t| t["kind"] == kind).unwrap()["id"]
                .as_str()
                .unwrap(),
        )
        .unwrap()
    };
    (
        Uuid::parse_str(catalog["sourceId"].as_str().unwrap()).unwrap(),
        id("video"),
        id("audio"),
    )
}

// Include as a child module of app_page.rs; exercises the actual Connection methods.
#[tokio::test]
async fn mpd_catalog_replacement_rejects_stale_choices_without_retiring_active_reader() -> Result<()>
{
    let _ = rustls::crypto::ring::default_provider().install_default();
    let paths = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let router = Router::new()
        .route("/{*path}", get(owned_manifest))
        .with_state(paths.clone());
    let (shutdown, stopped) = oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let page = Uuid::new_v4();
    let candidate_page = Uuid::new_v4();
    let choice_a = Uuid::new_v4();
    let choice_b = Uuid::new_v4();
    let (_page_lifetime, retired) = watch::channel(false);
    let (events, _events) = mpsc::channel(8);
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
                    let directory = if choice_id == choice_a {
                        "a"
                    } else {
                        assert_eq!(choice_id, choice_b);
                        "b"
                    };
                    let _ = reply.send(Ok((MediaContext {
                        url: format!("{origin}/{directory}/manifest.mpd"),
                        request: None,
                        format: Format::Dash,
                        size: None,
                        retired: retired.clone(),
                        cookies: Arc::new(|_| Box::pin(async { Ok(None) })),
                    }, Default::default())));
                }
                Command::Retire { .. } => {}
                _ => panic!("unexpected native command"),
            }
            true
        })),
        events,
    ));
    let registrations = Arc::new(AtomicUsize::new(0));
    let revocations = Arc::new(Mutex::new(Vec::new()));
    let (host, mut commands) = mpsc::channel(8);
    let registered = registrations.clone();
    let revoked = revocations.clone();
    let session = Uuid::new_v4();
    let (_provider_lifetime, provider_retired) = watch::channel(false);
    let host_task = tokio::spawn(async move {
        while let Some(command) = commands.recv().await {
            match command {
                HostCommand::RegisterWatchReader { result, .. } => {
                    let reply = if registered.fetch_add(1, Ordering::SeqCst) != 1 {
                        Ok(piik_channel_native::session::WatchReaderRegistration {
                            session_id: session,
                            retired: provider_retired.clone(),
                        })
                    } else {
                        Err("hosting_unavailable".to_owned())
                    };
                    let _ = result.send(reply);
                }
                HostCommand::RevokeWatchReader { resource_id } => {
                    revoked.lock().unwrap().push(resource_id)
                }
                _ => panic!("unexpected host command"),
            }
        }
    });
    let a = connection
        .inspect_mpd(page, choice_a, Uuid::new_v4())?
        .await?;
    if let Ok(path) = std::env::var("PIIK_MPD_CATALOG_EXPORT") {
        std::fs::write(path, serde_json::to_vec_pretty(&a)?)?;
    }
    let (source_a, video_a, audio_a) = selection(&a);
    connection
        .prepare_mpd_media(page, source_a, video_a, Some(audio_a), host.clone())?
        .await?;
    assert_eq!(connection.media_source(page).unwrap().resource_id, source_a);
    let before = connection
        .read_resource(page, source_a, source_a, Uuid::new_v4(), 0, 65536)?
        .await?;
    let manifest = Base64::decode_vec(before["bytesBase64"].as_str().unwrap()).unwrap();
    assert!(!manifest.is_empty());
    let b = connection
        .inspect_mpd(page, choice_b, Uuid::new_v4())?
        .await?;
    let (source_b, video_b, audio_b) = selection(&b);
    assert_ne!(source_a, source_b);
    assert_ne!(video_a, video_b);
    assert!(
        matches!(connection.prepare_mpd_media(page, source_a, video_a, Some(audio_a), host.clone()), Err(e) if e.to_string() == "watch_source_changed")
    );
    assert!(
        matches!(connection.prepare_mpd_media(page, source_b, video_a, Some(audio_b), host.clone()), Err(e) if e.to_string() == "watch_source_changed")
    );
    assert_eq!(registrations.load(Ordering::SeqCst), 1);
    let still_a = connection
        .read_resource(page, source_a, source_a, Uuid::new_v4(), 0, 65536)?
        .await?;
    assert_eq!(still_a["bytesBase64"], before["bytesBase64"]);
    assert!(
        matches!(connection.prepare_mpd_media(page, source_b, video_b, Some(audio_b), host.clone()), Err(e) if e.to_string() == "watch_source_busy")
    );
    assert_eq!(connection.media_source(page).unwrap().resource_id, source_a);
    // A replacement is prepared on its real candidate Page, never by overwriting an active Page.
    let candidate = connection
        .inspect_mpd(candidate_page, choice_b, Uuid::new_v4())?
        .await?;
    let (candidate_source, candidate_video, candidate_audio) = selection(&candidate);
    assert_ne!(candidate_source, source_b);
    assert!(
        matches!(connection.prepare_mpd_media(candidate_page, source_b, video_b, Some(audio_b), host.clone()), Err(e) if e.to_string() == "watch_source_changed")
    );
    let failed = connection
        .prepare_mpd_media(
            candidate_page,
            candidate_source,
            candidate_video,
            Some(candidate_audio),
            host.clone(),
        )?
        .await
        .unwrap_err();
    assert_eq!(failed.to_string(), "hosting_unavailable");
    assert!(connection.media_source(candidate_page).is_none());
    assert_eq!(connection.media_source(page).unwrap().resource_id, source_a);
    let after_failure = connection
        .read_resource(page, source_a, source_a, Uuid::new_v4(), 0, 65536)?
        .await?;
    assert_eq!(after_failure["bytesBase64"], before["bytesBase64"]);
    assert!(!revocations.lock().unwrap().contains(&source_a));
    assert_eq!(
        *paths.lock().unwrap(),
        vec!["/a/manifest.mpd", "/b/manifest.mpd", "/b/manifest.mpd"]
    );
    // The failed selection included audio. Retrying with video alone retires its omitted child.
    use piik_channel_native::watch::Reader;
    let candidate_reader = connection.media.lock().unwrap()[&candidate_page]
        .mpd
        .as_ref()
        .unwrap()
        .reader
        .clone();
    let manifest = String::from_utf8(
        candidate_reader
            .read(candidate_source, 0, 65536)
            .await?
            .bytes,
    )?;
    let failed_children: Vec<Uuid> = manifest
        .split("<BaseURL>")
        .skip(1)
        .map(|part| Uuid::parse_str(part.split("</BaseURL>").next().unwrap()).unwrap())
        .collect();
    assert_eq!(failed_children.len(), 2);
    connection
        .prepare_mpd_media(
            candidate_page,
            candidate_source,
            candidate_video,
            None,
            host.clone(),
        )?
        .await?;
    let manifest = String::from_utf8(
        candidate_reader
            .read(candidate_source, 0, 65536)
            .await?
            .bytes,
    )?;
    assert_eq!(manifest.matches("<BaseURL>").count(), 1);
    for child in failed_children
        .iter()
        .filter(|id| !manifest.contains(&id.to_string()))
    {
        assert_eq!(
            connection
                .read_resource(
                    candidate_page,
                    candidate_source,
                    *child,
                    Uuid::new_v4(),
                    0,
                    1
                )?
                .await
                .unwrap_err()
                .to_string(),
            "watch_resource_unavailable"
        );
    }
    assert_eq!(connection.media_reads.available_permits(), MAX_MEDIA_READS);
    assert!(connection.resource_reads.lock().unwrap().is_empty());
    connection.stop_media(candidate_page);
    connection.stop_media(page);
    assert!(connection.media_source(page).is_none());
    assert!(
        matches!(connection.read_resource(page, source_a, source_a, Uuid::new_v4(), 0, 16), Err(e) if e.to_string() == "watch_source_retired")
    );
    drop(connection);
    drop(host);
    host_task.abort();
    let _ = host_task.await;
    let _ = shutdown.send(());
    server.await?;
    Ok(())
}
#[tokio::test]
async fn mpd_inspection_cancel_uses_existing_read_owner_and_releases_pending_context() -> Result<()>
{
    let held = Arc::new(Mutex::new(None));
    let capture = held.clone();
    let (events, _) = mpsc::channel(8);
    let connection = Arc::new(Connection::new(
        Some(Arc::new(move |command| {
            match command {
                Command::Media { reply, .. } => *capture.lock().unwrap() = Some(reply),
                Command::Retire { .. } => {}
                _ => panic!("unexpected"),
            };
            true
        })),
        events,
    ));
    let page = Uuid::new_v4();
    let read_id = Uuid::new_v4();
    let work = connection.inspect_mpd(page, Uuid::new_v4(), read_id)?;
    let waiting = tokio::spawn(work);
    tokio::time::timeout(Duration::from_secs(1), async {
        while held.lock().unwrap().is_none() {
            tokio::task::yield_now().await
        }
    })
    .await?;
    connection.cancel_resource(page, read_id);
    assert_eq!(
        waiting.await?.err().unwrap().to_string(),
        "watch_read_cancelled"
    );
    assert!(held.lock().unwrap().as_ref().unwrap().is_closed());
    assert_eq!(connection.media_reads.available_permits(), MAX_MEDIA_READS);
    assert!(connection.resource_reads.lock().unwrap().is_empty());
    assert!(connection
        .media
        .lock()
        .unwrap()
        .get(&page)
        .unwrap()
        .inspection
        .is_none());
    Ok(())
}

#[path = "mpd_catalog_revision_tests.rs"]
mod catalog_revision;
