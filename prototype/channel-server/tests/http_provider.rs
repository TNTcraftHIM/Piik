//! A separate test process prevents another TLS user from hiding missing App initialization.
use anyhow::Result;
use axum::{
    body::Body,
    http::{HeaderMap, Response},
    routing::get,
    Router,
};
use piik_channel_native::session::HostCommand;
use piik_channel_prototype::app::{self, page};
use std::sync::Arc;
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot, watch},
};
use uuid::Uuid;

#[tokio::test]
async fn app_startup_precedes_first_page_http_client() -> Result<()> {
    assert!(rustls::crypto::CryptoProvider::get_default().is_none());
    let directory = tempfile::tempdir()?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let (stop, stopped) = oneshot::channel();
    let (ready, started) = oneshot::channel();
    let app = tokio::spawn(app::serve(
        listener,
        app::Config {
            data_root: directory.path().into(),
            assets: directory.path().into(),
            open_browser: false,
            page_player: None,
            website_permission_reset: None,
            window_navigation: None,
            cloudflared: Default::default(),
            ice_servers: vec![],
            update: Default::default(),
        },
        async {
            let _ = stopped.await;
        },
        Some(ready),
    ));
    started.await?;

    let origin = TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/media", origin.local_addr()?);
    let http = tokio::spawn(async move {
        axum::serve(
            origin,
            Router::new().route(
                "/media",
                get(|headers: HeaderMap| async move {
                    let offset = if headers["range"] == "bytes=0-0" {
                        0
                    } else {
                        1
                    };
                    Response::builder()
                        .status(206)
                        .header("Content-Type", "video/mp4")
                        .header("Content-Range", format!("bytes {offset}-{offset}/2"))
                        .body(Body::from(vec![42u8]))
                        .unwrap()
                }),
            ),
        )
        .await
    });
    let (_retire, retired) = watch::channel(false);
    let dispatch: page::Dispatcher = Arc::new(move |command| {
        if let page::Command::Media { reply, .. } = command {
            let _ = reply.send(Ok(page::MediaContext {
                // Exercise both ordinary and observed-request clients, with no credentials.
                request: Some(Arc::new(page::ObservedRequestContext {
                    url: url.parse().unwrap(),
                    referer: None,
                    user_agent: None,
                })),
                url: url.clone(),
                format: page::Format::File,
                size: Some(2),
                retired: retired.clone(),
                cookies: Arc::new(|_| Box::pin(async { Ok(None) })),
            }));
        }
        true
    });
    let (events, _) = mpsc::channel(8);
    let connection = Arc::new(page::Connection::new(Some(dispatch), events));
    let (commands, mut requests) = mpsc::channel(8);
    let host = tokio::spawn(async move {
        let Some(HostCommand::RegisterWatchReader {
            resource_id,
            reader,
            result,
        }) = requests.recv().await
        else {
            panic!("Page did not register its prepared reader");
        };
        result.send(Ok(Uuid::new_v4())).unwrap();
        let Some(HostCommand::RevokeWatchReader {
            resource_id: retired,
        }) = requests.recv().await
        else {
            panic!("Page did not retire its reader");
        };
        assert_eq!(resource_id, retired);
        drop(reader);
    });
    let page_id = Uuid::new_v4();
    let prepared = connection
        .prepare_media(page_id, Uuid::new_v4(), commands)?
        .await?;
    let root = prepared["resourceId"].as_str().unwrap().parse()?;
    let read = connection
        .read_resource(page_id, root, root, Uuid::new_v4(), 0, 1)?
        .await?;
    assert_eq!(read["bytesBase64"], "Kg==");
    assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    connection.stop_media(page_id);
    host.await?;
    stop.send(()).unwrap();
    app.await??;
    http.abort();
    let _ = http.await;
    Ok(())
}
