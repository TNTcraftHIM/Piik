use super::*;
use axum::{
    body::Body,
    extract::{Request, State},
    http::{Response, StatusCode},
    routing::get,
    Router,
};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Mutex as StdMutex,
};
#[derive(Default)]
struct HttpFacts {
    requests: StdMutex<Vec<(String, Option<String>)>>,
    hold: AtomicBool,
    active: AtomicUsize,
}
struct Active(Arc<HttpFacts>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}
async fn origin(State(f): State<Arc<HttpFacts>>, r: Request) -> Response<Body> {
    assert_eq!(r.headers().get("cookie").unwrap(), "Owned=fixture");
    assert_eq!(r.headers().get("user-agent").unwrap(), "OwnedNative");
    assert_eq!(
        r.headers().get("referer").unwrap(),
        "https://owned.invalid/page"
    );
    let path = r.uri().path().to_owned();
    let range = r
        .headers()
        .get("range")
        .map(|v| v.to_str().unwrap().to_owned());
    f.requests
        .lock()
        .unwrap()
        .push((path.clone(), range.clone()));
    if path == "/manifest.mpd" {
        return Response::builder()
            .header("content-type", "application/dash+xml")
            .body(Body::from(include_str!(
                "../../../channel-mpd/fixtures/angel-one.mpd"
            )))
            .unwrap();
    }
    let r = range.unwrap();
    let (a, b) = r.strip_prefix("bytes=").unwrap().split_once('-').unwrap();
    let start: usize = a.parse().unwrap();
    let end: usize = b.parse().unwrap();
    let body = if f.hold.load(Ordering::SeqCst) {
        f.active.fetch_add(1, Ordering::SeqCst);
        let guard = Active(f.clone());
        Body::from_stream(futures_util::stream::once(async move {
            let _guard = guard;
            std::future::pending::<Result<axum::body::Bytes, std::io::Error>>().await
        }))
    } else {
        Body::from((start..=end).map(|v| (v % 251) as u8).collect::<Vec<_>>())
    };
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header("content-type", "video/mp4")
        .header("content-range", format!("bytes {start}-{end}/2048"))
        .header("content-length", (end - start + 1).to_string())
        .body(body)
        .unwrap()
}
#[tokio::test]
async fn native_mpd_selected_graph_uses_actual_reader_context_ranges_and_retirement() -> Result<()>
{
    let _ = rustls::crypto::ring::default_provider().install_default();
    let facts = Arc::new(HttpFacts::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}/manifest.mpd", listener.local_addr()?);
    let app = Router::new()
        .route("/{*path}", get(origin))
        .with_state(facts.clone());
    let (server_stop, done) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = done.await;
            })
            .await
            .unwrap()
    });
    let (page, retired) = watch::channel(false);
    let (stop, stopped) = watch::channel(false);
    let context = |retired| MediaContext {
        request: Some(Arc::new(crate::app::page::ObservedRequestContext {
            url: base.parse().unwrap(),
            referer: Some("https://owned.invalid/page".parse().unwrap()),
            user_agent: Some("OwnedNative".parse().unwrap()),
        })),
        url: base.clone(),
        format: Format::File,
        size: None,
        retired,
        cookies: Arc::new(|_| Box::pin(async { Ok(Some("Owned=fixture".into())) })),
    };
    let (reader, snapshot) = OriginReader::prepare_mpd(context(retired), stopped).await?;
    assert_eq!(facts.requests.lock().unwrap().len(), 1);
    let ids = ["7", "13"].map(|label| {
        snapshot
            .choices()
            .iter()
            .find(|c| c.info.label == label)
            .unwrap()
            .id
    });
    assert!(reader
        .admit_mpd(snapshot.clone(), vec![Uuid::new_v4()])
        .await
        .is_err());
    assert_eq!(reader.resources.lock().await.len(), 1);
    reader.admit_mpd(snapshot.clone(), ids.to_vec()).await?;
    let admitted: BTreeMap<_, _> = reader
        .resources
        .lock()
        .await
        .iter()
        .filter_map(|(id, resource)| match resource {
            Resource::File { url, .. } => Some((url.to_string(), *id)),
            _ => None,
        })
        .collect();
    assert_eq!(admitted.len(), 2);
    let mpd = reader.read(reader.root, 0, 65536).await?;
    assert_eq!(mpd.mime_type, "application/dash+xml");
    let xml = String::from_utf8(mpd.bytes)?;
    assert!(xml.contains("SegmentBase"));
    assert!(!xml.contains("127.0.0.1"));
    assert!(!xml.contains("video_360p_400k_h264.mp4"));
    assert_eq!(facts.requests.lock().unwrap().len(), 1);
    let mut reads = 0;
    for track in snapshot.resolve_selected(&ids)? {
        for recipe in track.resources() {
            let range = recipe.range.as_ref().unwrap();
            let data = reader
                .read(admitted[&recipe.url], range.offset, range.length as u32)
                .await?;
            assert_eq!(
                data.bytes,
                (range.offset..range.offset + range.length)
                    .map(|v| (v % 251) as u8)
                    .collect::<Vec<_>>()
            );
            reads += 1
        }
    }
    assert_eq!(reads, 4);
    assert_eq!(facts.requests.lock().unwrap().len(), 5);
    assert!(facts
        .requests
        .lock()
        .unwrap()
        .iter()
        .skip(1)
        .all(|(p, _)| p.contains("video_360p_400k_h264") || p.contains("audio_en_2c_128k_aac")));
    let selected = *admitted.values().next().unwrap();
    assert_eq!(reader.read(selected, 1200, 16).await?.bytes.len(), 16);
    let before = facts.requests.lock().unwrap().len();
    assert!(reader.read(Uuid::new_v4(), 0, 16).await.is_err());
    assert_eq!(facts.requests.lock().unwrap().len(), before);
    let (_page_b, retired_b) = watch::channel(false);
    let (_stop_b, stopped_b) = watch::channel(false);
    let (other, _) = OriginReader::prepare_mpd(context(retired_b), stopped_b).await?;
    assert!(other.admit_mpd(snapshot, ids.to_vec()).await.is_err());
    facts.hold.store(true, Ordering::SeqCst);
    let source = reader.clone();
    let reading = tokio::spawn(async move { source.read(selected, 1500, 16).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while facts.active.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await
        }
    })
    .await?;
    page.send_replace(true);
    assert_eq!(
        reading.await?.err().unwrap().to_string(),
        "watch_source_retired"
    );
    assert!(reader.read(selected, 0, 16).await.is_err());
    tokio::time::timeout(Duration::from_secs(2), async {
        while facts.active.load(Ordering::SeqCst) != 0 {
            tokio::task::yield_now().await
        }
    })
    .await?;
    stop.send_replace(true);
    drop(reader);
    drop(other);
    let _ = server_stop.send(());
    server.await?;
    Ok(())
}
