use super::*;
use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, Response},
    routing::get,
    Router,
};
use piik_channel_native::session::WatchReaderRegistration;
use std::sync::atomic::{AtomicUsize, Ordering};

#[tokio::test]
async fn indexed_file_keeps_the_inspected_version_through_registration_and_playback() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/entry", listener.local_addr().unwrap());
    // 0 = original, 1 = same URL/new tag, 2 = new redirect target/same tag.
    let revision = Arc::new(AtomicUsize::new(0));
    let app = Router::new()
        .route(
            "/entry",
            get(|State(version): State<Arc<AtomicUsize>>| async move {
                let location = if version.load(Ordering::SeqCst) == 2 {
                    "/file/other"
                } else {
                    "/file/first"
                };
                axum::response::Redirect::temporary(location)
            }),
        )
        .route(
            "/file/{name}",
            get(
                |Path(_): Path<String>,
                 State(version): State<Arc<AtomicUsize>>,
                 headers: HeaderMap| async move {
                    let range = headers["range"]
                        .to_str()
                        .unwrap()
                        .strip_prefix("bytes=")
                        .unwrap();
                    let (start, end) = range.split_once('-').unwrap();
                    let len = end.parse::<usize>().unwrap() - start.parse::<usize>().unwrap() + 1;
                    let tag = if version.load(Ordering::SeqCst) == 1 {
                        "\"B\""
                    } else {
                        "\"A\""
                    };
                    Response::builder()
                        .status(206)
                        .header("content-range", format!("bytes {range}/8"))
                        .header("etag", tag)
                        .body(Body::from(vec![42; len]))
                        .unwrap()
                },
            ),
        )
        .with_state(revision.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let file = IndexedFile::default();
    let (_page_lifetime, retired) = watch::channel(false);
    let (events, _) = mpsc::channel(4);
    let choice = Uuid::new_v4();
    let connection = Arc::new(Connection::new(
        Some(Arc::new(move |command| {
            if let Command::Media {
                indexed: true,
                choice_id,
                reply,
                ..
            } = command
            {
                assert_eq!(choice_id, choice);
                let context = MediaContext {
                    url: url.clone(),
                    request: None,
                    format: Format::File,
                    size: Some(8),
                    retired: retired.clone(),
                    cookies: Arc::new(|_| Box::pin(async { Ok(None) })),
                };
                let _ = reply.send(Ok((context, file.clone())));
            }
            true
        })),
        events,
    ));
    let page = Uuid::new_v4();
    let metadata = |offset| {
        connection
            .read_metadata(page, None, choice, Uuid::new_v4(), offset, 2)
            .unwrap()
    };
    let recipe = indexed::TrackRecipe {
        choice_id: choice,
        total_size: 8,
        codec: "avc1".into(),
        timescale: 1,
        media_offset: 4,
        init_base64: "Kg==".into(),
        segments: vec![(4, 1)],
    };
    let (host, mut commands) = mpsc::channel(4);
    let prepare = || {
        connection
            .prepare_indexed_media(page, None, recipe.clone(), None, host.clone())
            .unwrap()
    };
    assert_eq!(metadata(0).await.unwrap()["bytesBase64"], "Kio=");
    for changed in [1, 2] {
        revision.store(changed, Ordering::SeqCst);
        assert_eq!(
            metadata(2).await.unwrap_err().to_string(),
            "watch_media_unavailable"
        );
        assert_eq!(
            prepare().await.unwrap_err().to_string(),
            "watch_media_unavailable"
        );
        assert!(commands.try_recv().is_err());
    }
    revision.store(0, Ordering::SeqCst);
    assert_eq!(metadata(2).await.unwrap()["bytesBase64"], "Kio=");
    let (_host_lifetime, retired) = watch::channel(false);
    let register = async {
        let Some(HostCommand::RegisterWatchReader {
            resource_id,
            reader,
            result,
        }) = commands.recv().await
        else {
            panic!("expected reader")
        };
        result
            .send(Ok(WatchReaderRegistration {
                session_id: Uuid::new_v4(),
                retired,
            }))
            .unwrap();
        (resource_id, reader)
    };
    let (prepared, (root, reader)) = tokio::join!(prepare(), register);
    prepared.unwrap();
    let playlist = |bytes: Vec<u8>| {
        String::from_utf8(bytes)
            .unwrap()
            .lines()
            .filter_map(|line| Uuid::parse_str(line).ok())
            .next()
            .unwrap()
    };
    let track = playlist(reader.read(root, 0, 65536).await.unwrap().bytes);
    let resource = playlist(reader.read(track, 0, 65536).await.unwrap().bytes);
    assert_eq!(
        reader.read(resource, 4, 4).await.unwrap().bytes,
        vec![42; 4]
    );
    revision.store(1, Ordering::SeqCst);
    assert_eq!(
        reader.read(resource, 4, 4).await.err().unwrap().to_string(),
        "watch_media_unavailable"
    );
    connection.stop_media(page);
    assert_eq!(
        reader.read(resource, 4, 4).await.err().unwrap().to_string(),
        "watch_source_retired"
    );
    server.abort();
    let _ = server.await;
}
