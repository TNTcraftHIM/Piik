//! Origin reads remain inside a selected page lease; peers address admitted IDs only.
use super::{Format, MediaContext};
use anyhow::{anyhow, bail, ensure, Result};
use piik_channel_native::watch::{ReadResult, Reader};
use std::{collections::BTreeMap, future::Future, pin::Pin, sync::Arc};
use tokio::sync::{watch, Mutex};
use uuid::Uuid;

const MAX_MANIFEST: usize = 1024 * 1024;
const MAX_RESOURCES: usize = 32768;

fn request_failure(error: reqwest::Error) -> anyhow::Error {
    let code = if error.is_timeout() {
        "watch_media_timeout"
    } else {
        "watch_media_unavailable"
    };
    // The opt-in App recorder receives derived transport facts, never the source URL or text.
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(&error);
    let mut io_kind = None;
    for _ in 0..8 {
        let Some(current) = source else { break };
        if let Some(io) = current.downcast_ref::<std::io::Error>() {
            io_kind = Some(io.kind());
            break;
        }
        source = current.source();
    }
    log::warn!(target: "piik.app", "Media request failed: timeout={} connect={} request={} redirect={} io_kind={io_kind:?}",
        error.is_timeout(), error.is_connect(), error.is_request(), error.is_redirect());
    anyhow::Error::new(error.without_url()).context(code)
}
#[derive(Clone)]
enum Resource {
    File {
        url: url::Url,
        size: Option<u64>,
    },
    Playlist {
        url: url::Url,
        bytes: Option<Arc<Vec<u8>>>,
    },
}
pub struct OriginReader {
    pub root: Uuid,
    context: MediaContext,
    stopped: watch::Receiver<bool>,
    client: reqwest::Client,
    context_client: Option<reqwest::Client>,
    resources: Mutex<BTreeMap<Uuid, Resource>>,
}
impl OriginReader {
    pub async fn read_metadata(
        context: MediaContext,
        stopped: watch::Receiver<bool>,
        offset: u64,
        length: u32,
    ) -> Result<ReadResult> {
        ensure!(context.format == Format::File, "watch_resource_unavailable");
        ensure!(
            context.size.is_some_and(|size| offset < size),
            "invalid_watch_range"
        );
        let reader = Self::new(context, stopped)?;
        reader.read(reader.root, offset, length).await
    }

    pub async fn prepare(
        context: MediaContext,
        stopped: watch::Receiver<bool>,
    ) -> Result<Arc<Self>> {
        let reader = Self::new(context, stopped)?;
        let root = reader.root;
        // Prove the root before replacing an active source lease.
        reader.read(root, 0, 1).await?;
        if reader.context.format == Format::File {
            let size = reader
                .context
                .size
                .ok_or_else(|| anyhow!("watch_media_size_unavailable"))?;
            if size > 1 {
                reader.read(root, 1, 1).await?;
            }
        }
        Ok(reader)
    }
    fn new(context: MediaContext, stopped: watch::Receiver<bool>) -> Result<Arc<Self>> {
        let root = Uuid::new_v4();
        let url = url::Url::parse(&context.url)?;
        let resource = match context.format {
            Format::File => Resource::File {
                url,
                size: context.size,
            },
            Format::Hls => Resource::Playlist { url, bytes: None },
        };
        let client = |policy| {
            reqwest::Client::builder()
                .redirect(policy)
                .referer(false)
                .timeout(std::time::Duration::from_secs(15))
                .build()
        };
        let context_client = context
            .request
            .as_ref()
            .map(|request| {
                let origin = request.url.origin();
                let limited = reqwest::redirect::Policy::limited(10);
                client(reqwest::redirect::Policy::custom(move |attempt| {
                    if attempt.url().origin() != origin {
                        attempt.stop()
                    } else {
                        limited.redirect(attempt)
                    }
                }))
            })
            .transpose()?;
        let reader = Arc::new(Self {
            root,
            context,
            stopped,
            // reqwest removes sensitive headers across origins; source URLs may contain grants.
            client: client(reqwest::redirect::Policy::limited(10))?,
            context_client,
            resources: Mutex::new(BTreeMap::from([(root, resource)])),
        });
        Ok(reader)
    }
    async fn response(
        &self,
        url: &url::Url,
        offset: u64,
        length: Option<u32>,
    ) -> Result<reqwest::Response> {
        let observed = self
            .context
            .request
            .as_ref()
            .filter(|request| url.origin() == request.url.origin());
        let client = if observed.is_some() {
            self.context_client.as_ref().unwrap()
        } else {
            &self.client
        };
        let mut request = client
            .get(url.clone())
            .header(reqwest::header::ACCEPT_ENCODING, "identity");
        if let Some(length) = length {
            request = request.header(
                reqwest::header::RANGE,
                format!(
                    "bytes={offset}-{}",
                    offset
                        .checked_add(length as u64 - 1)
                        .ok_or_else(|| anyhow!("invalid_watch_range"))?
                ),
            );
        }
        if url.origin() == url::Url::parse(&self.context.url)?.origin() {
            if let Some(cookie) = (self.context.cookies)(url.as_str().to_owned()).await? {
                request = request.header(reqwest::header::COOKIE, cookie);
            }
        }
        if let Some(observed) = observed {
            if let Some(value) = &observed.referer {
                request = request.header(reqwest::header::REFERER, value);
            }
            if let Some(value) = &observed.user_agent {
                request = request.header(reqwest::header::USER_AGENT, value);
            }
        }
        let response = request.send().await.map_err(request_failure)?;
        ensure!(
            response.status().is_success() || response.status().as_u16() == 416,
            "watch_media_unavailable"
        );
        if response.status().as_u16() == 416 {
            return Ok(response);
        }
        ensure!(
            response
                .headers()
                .get(reqwest::header::CONTENT_ENCODING)
                .is_none_or(|v| v == "identity"),
            "watch_media_encoding_unsupported"
        );
        Ok(response)
    }
    async fn window(&self, id: Uuid, offset: u64, length: u32) -> Result<ReadResult> {
        ensure!(length > 0 && length <= 64 * 1024, "invalid_watch_range");
        let resource = self
            .resources
            .lock()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(|| anyhow!("watch_resource_unavailable"))?;
        match resource {
            Resource::Playlist { url, bytes } => {
                let bytes = match bytes {
                    Some(bytes) => bytes,
                    None => self.playlist(id, &url).await?,
                };
                let start = usize::try_from(offset)
                    .unwrap_or(usize::MAX)
                    .min(bytes.len());
                let end = start.saturating_add(length as usize).min(bytes.len());
                Ok(ReadResult {
                    mime_type: "application/vnd.apple.mpegurl".into(),
                    total_size: Some(bytes.len() as u64),
                    bytes: bytes[start..end].to_vec(),
                    eof: end == bytes.len(),
                })
            }
            Resource::File { url, size } => {
                if let Some(size) = size {
                    if offset >= size {
                        return Ok(ReadResult {
                            mime_type: mime_for(&url),
                            total_size: Some(size),
                            bytes: vec![],
                            eof: true,
                        });
                    }
                }
                let mut response = self.response(&url, offset, Some(length)).await?;
                let status = response.status().as_u16();
                let range = response
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok());
                if status == 416 {
                    let total = range
                        .and_then(|v| v.strip_prefix("bytes */"))
                        .and_then(|v| v.parse::<u64>().ok())
                        .ok_or_else(|| anyhow!("invalid_watch_range_response"))?;
                    ensure!(
                        offset >= total && size.is_none_or(|size| size == total),
                        "invalid_watch_range_response"
                    );
                    return Ok(ReadResult {
                        mime_type: mime_for(&url),
                        total_size: Some(total),
                        bytes: vec![],
                        eof: true,
                    });
                }
                ensure!(matches!(status, 200 | 206), "watch_media_unavailable");
                let (available, total) = if status == 206 {
                    let (start, end, total) =
                        parse_range(range.ok_or_else(|| anyhow!("invalid_watch_range_response"))?)?;
                    ensure!(
                        start == offset
                            && end - start + 1 <= length as u64
                            && end < total
                            && size.is_none_or(|size| size == total),
                        "invalid_watch_range_response"
                    );
                    (end - start + 1, total)
                } else {
                    ensure!(
                        status == 200 && offset == 0,
                        "watch_media_range_unsupported"
                    );
                    let total = response
                        .content_length()
                        .ok_or_else(|| anyhow!("watch_media_size_unavailable"))?;
                    ensure!(size.is_none_or(|size| size == total), "watch_media_changed");
                    (total.min(length as u64), total)
                };
                let mime_type = response
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .filter(|v| v.len() <= 256)
                    .unwrap_or("application/octet-stream")
                    .to_owned();
                if status == 206 {
                    ensure!(
                        response.content_length().is_none_or(|v| v == available),
                        "invalid_watch_range_response"
                    );
                }
                let mut bytes = Vec::with_capacity(available as usize);
                while bytes.len() < available as usize {
                    let chunk = response
                        .chunk()
                        .await
                        .map_err(reqwest::Error::without_url)?
                        .ok_or_else(|| anyhow!("watch_media_truncated"))?;
                    if status == 206 {
                        ensure!(
                            chunk.len() <= available as usize - bytes.len(),
                            "invalid_watch_range_response"
                        );
                    }
                    let count = chunk.len().min(available as usize - bytes.len());
                    bytes.extend_from_slice(&chunk[..count]);
                }
                if status == 206 {
                    ensure!(
                        response
                            .chunk()
                            .await
                            .map_err(reqwest::Error::without_url)?
                            .is_none(),
                        "invalid_watch_range_response"
                    );
                }
                ensure!(
                    available == length as u64 || offset + available == total,
                    "watch_media_truncated"
                );
                Ok(ReadResult {
                    mime_type,
                    total_size: Some(total),
                    eof: offset + available == total,
                    bytes,
                })
            }
        }
    }
    async fn playlist(&self, id: Uuid, url: &url::Url) -> Result<Arc<Vec<u8>>> {
        // Serialize playlist admission so readers never see half a rewritten resource graph.
        let mut resources = self.resources.lock().await;
        if let Some(Resource::Playlist {
            bytes: Some(bytes), ..
        }) = resources.get(&id)
        {
            return Ok(bytes.clone());
        }
        let mut response = self.response(url, 0, None).await?;
        ensure!(response.status().is_success(), "watch_media_unavailable");
        ensure!(
            response
                .content_length()
                .is_none_or(|size| size <= MAX_MANIFEST as u64),
            "watch_manifest_limit"
        );
        let resolved_url = response.url().clone();
        let mut bytes = vec![];
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(reqwest::Error::without_url)?
        {
            ensure!(
                bytes.len() + chunk.len() <= MAX_MANIFEST,
                "watch_manifest_limit"
            );
            bytes.extend_from_slice(&chunk);
        }
        let rewritten = rewrite(&bytes, &resolved_url, &mut resources)?;
        let retained: usize = resources
            .values()
            .map(|r| match r {
                Resource::Playlist {
                    bytes: Some(bytes), ..
                } => bytes.len(),
                _ => 0,
            })
            .sum();
        ensure!(
            retained + rewritten.len() <= 16 * 1024 * 1024,
            "watch_manifest_limit"
        );
        let rewritten = Arc::new(rewritten);
        resources.insert(
            id,
            Resource::Playlist {
                url: url.clone(),
                bytes: Some(rewritten.clone()),
            },
        );
        Ok(rewritten)
    }
}
impl Reader for OriginReader {
    fn read(
        &self,
        id: Uuid,
        offset: u64,
        length: u32,
    ) -> Pin<Box<dyn Future<Output = Result<ReadResult>> + Send + '_>> {
        Box::pin(async move {
            let mut page = self.context.retired.clone();
            let mut stopped = self.stopped.clone();
            tokio::select! {
                biased;
                _ = page.wait_for(|v|*v) => bail!("watch_source_retired"),
                _ = stopped.wait_for(|v|*v) => bail!("watch_source_retired"),
                result = self.window(id,offset,length) => result,
            }
        })
    }
}
fn parse_range(value: &str) -> Result<(u64, u64, u64)> {
    let (span, total) = value
        .strip_prefix("bytes ")
        .and_then(|v| v.split_once('/'))
        .ok_or_else(|| anyhow!("invalid_watch_range_response"))?;
    let (start, end) = span
        .split_once('-')
        .ok_or_else(|| anyhow!("invalid_watch_range_response"))?;
    let (start, end, total) = (start.parse()?, end.parse()?, total.parse()?);
    ensure!(start <= end && end < total, "invalid_watch_range_response");
    Ok((start, end, total))
}
fn mime_for(url: &url::Url) -> String {
    let _ = url;
    "application/octet-stream".into()
}

fn rewrite(
    bytes: &[u8],
    base: &url::Url,
    resources: &mut BTreeMap<Uuid, Resource>,
) -> Result<Vec<u8>> {
    use m3u8_rs::{Playlist, SessionDataField};
    let (rest, mut playlist) =
        m3u8_rs::parse_playlist(bytes).map_err(|_| anyhow!("watch_invalid_manifest"))?;
    ensure!(
        rest.iter().all(u8::is_ascii_whitespace),
        "watch_invalid_manifest"
    );
    // Unknown URI-bearing extensions cannot be passed through to the remote Browser.
    let text = std::str::from_utf8(bytes)?;
    for line in text.lines().filter(|line| line.starts_with("#EXT")) {
        let tag = line.split(':').next().unwrap_or("");
        if line.contains("URI=") {
            ensure!(
                matches!(
                    tag,
                    "#EXT-X-MEDIA"
                        | "#EXT-X-I-FRAME-STREAM-INF"
                        | "#EXT-X-KEY"
                        | "#EXT-X-SESSION-KEY"
                        | "#EXT-X-MAP"
                        | "#EXT-X-SESSION-DATA"
                ),
                "watch_manifest_extension_unsupported"
            );
        }
        ensure!(
            !matches!(
                tag,
                "#EXT-X-DEFINE" | "#EXT-X-PART" | "#EXT-X-PART-INF" | "#EXT-X-SERVER-CONTROL"
            ),
            "watch_manifest_extension_unsupported"
        );
    }
    let mut pending = BTreeMap::new();
    let mut known: BTreeMap<String, Uuid> = resources
        .iter()
        .map(|(id, r)| match r {
            Resource::File { url, .. } | Resource::Playlist { url, .. } => {
                (url.as_str().to_owned(), *id)
            }
        })
        .collect();
    let mut admit = |uri: &mut String, playlist: bool| -> Result<()> {
        let url = base.join(uri)?;
        ensure!(super::valid_url(url.as_str()), "invalid_watch_url");
        let existing = known.get(url.as_str()).copied();
        let id = if let Some(id) = existing {
            id
        } else {
            ensure!(
                resources.len() + pending.len() < MAX_RESOURCES,
                "watch_resource_limit"
            );
            let id = Uuid::new_v4();
            known.insert(url.as_str().to_owned(), id);
            pending.insert(
                id,
                if playlist {
                    Resource::Playlist { url, bytes: None }
                } else {
                    Resource::File { url, size: None }
                },
            );
            id
        };
        *uri = id.to_string();
        Ok(())
    };
    let key = |key: &mut m3u8_rs::Key,
               admit: &mut dyn FnMut(&mut String, bool) -> Result<()>|
     -> Result<()> {
        ensure!(
            matches!(
                key.method,
                m3u8_rs::KeyMethod::None | m3u8_rs::KeyMethod::AES128
            ) && key.keyformat.as_deref().is_none_or(|v| v == "identity"),
            "watch_media_encryption_unsupported"
        );
        if let Some(uri) = &mut key.uri {
            admit(uri, false)?;
        }
        Ok(())
    };
    match &mut playlist {
        Playlist::MasterPlaylist(master) => {
            safe_unknown(&master.unknown_tags)?;
            for variant in &mut master.variants {
                safe_attributes(variant.other_attributes.as_ref())?;
                admit(&mut variant.uri, true)?;
            }
            for alternative in &mut master.alternatives {
                safe_attributes(alternative.other_attributes.as_ref())?;
                if let Some(uri) = &mut alternative.uri {
                    admit(uri, true)?;
                }
            }
            for session in &mut master.session_key {
                key(&mut session.0, &mut admit)?;
            }
            for data in &mut master.session_data {
                safe_attributes(data.other_attributes.as_ref())?;
                if let SessionDataField::Uri(uri) = &mut data.field {
                    admit(uri, false)?;
                }
            }
        }
        Playlist::MediaPlaylist(media) => {
            ensure!(media.end_list, "watch_live_hls_unsupported");
            safe_unknown(&media.unknown_tags)?;
            for segment in &mut media.segments {
                safe_unknown(&segment.unknown_tags)?;
                admit(&mut segment.uri, false)?;
                if let Some(map) = &mut segment.map {
                    safe_attributes(Some(&map.other_attributes))?;
                    admit(&mut map.uri, false)?;
                }
                if let Some(encryption) = &mut segment.key {
                    key(encryption, &mut admit)?;
                }
            }
        }
    }
    let mut rewritten = vec![];
    playlist.write_to(&mut rewritten)?;
    ensure!(rewritten.len() <= MAX_MANIFEST, "watch_manifest_limit");
    resources.extend(pending);
    Ok(rewritten)
}

fn safe_unknown(tags: &[m3u8_rs::ExtTag]) -> Result<()> {
    for tag in tags {
        ensure!(
            !tag.rest.as_ref().is_some_and(|v| v.contains("URI=")),
            "watch_manifest_extension_unsupported"
        );
    }
    Ok(())
}
fn safe_attributes(
    attributes: Option<&std::collections::HashMap<String, m3u8_rs::QuotedOrUnquoted>>,
) -> Result<()> {
    if let Some(attributes) = attributes {
        ensure!(
            !attributes.keys().any(|key| key.contains("URI")),
            "watch_manifest_extension_unsupported"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, extract::Request, http::Response, routing::get, Router};
    async fn origin(request: Request) -> Response<Body> {
        let path = request.uri().path();
        if path == "/denied" {
            return Response::builder()
                .status(403)
                .header("content-encoding", "gzip")
                .body(Body::empty())
                .unwrap();
        }
        if path == "/master.m3u8" {
            return Response::builder()
                .header("content-type", "application/vnd.apple.mpegurl")
                .body(Body::from(
                    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvod.m3u8\n",
                ))
                .unwrap();
        }
        if path == "/vod.m3u8" {
            return Response::builder().body(Body::from("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n")).unwrap();
        }
        if path == "/slow" {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        }
        let size = if path == "/big" {
            200 * 1024 * 1024u64
        } else {
            if path == "/key.bin" {
                16
            } else {
                128
            }
        };
        let (start, requested_end) = request
            .headers()
            .get("range")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("bytes="))
            .and_then(|v| v.split_once('-'))
            .map(|(a, b)| (a.parse::<u64>().unwrap(), b.parse::<u64>().unwrap()))
            .unwrap_or((0, size - 1));
        if start >= size {
            return Response::builder()
                .status(416)
                .header("content-range", format!("bytes */{size}"))
                .body(Body::empty())
                .unwrap();
        }
        let end = requested_end.min(size - 1);
        let bytes = (start..=end).map(|i| (i % 251) as u8).collect::<Vec<_>>();
        let mut response = Response::builder()
            .status(if path == "/ignore" { 200 } else { 206 })
            .header(
                "content-type",
                if path == "/segment.ts" {
                    "video/mp2t"
                } else {
                    "video/mp4"
                },
            );
        if path != "/ignore" {
            response = response.header(
                "content-range",
                format!(
                    "bytes {}-{end}/{size}",
                    if path == "/wrong" { start + 1 } else { start }
                ),
            );
        }
        if path == "/short" {
            return response
                .body(Body::from(bytes[..bytes.len().saturating_sub(1)].to_vec()))
                .unwrap();
        }
        response.body(Body::from(bytes)).unwrap()
    }
    async fn fixture() -> (String, tokio::task::JoinHandle<()>) {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/{*path}", get(origin)))
                .await
                .unwrap();
        });
        (url, task)
    }
    fn context(
        url: String,
        format: Format,
        size: Option<u64>,
    ) -> (MediaContext, watch::Sender<bool>, watch::Receiver<bool>) {
        let (page, retired) = watch::channel(false);
        let (_, stop) = watch::channel(false);
        (
            MediaContext {
                url,
                request: None,
                format,
                size,
                retired,
                cookies: Arc::new(|_| Box::pin(async { Ok(None) })),
            },
            page,
            stop,
        )
    }
    #[tokio::test]
    async fn metadata_http_failure_is_distinct_from_an_ignored_successful_range() {
        let (base, server) = fixture().await;
        let (_stop, stopped) = watch::channel(false);
        for (path, error) in [
            ("denied", "watch_media_unavailable"),
            ("ignore", "watch_media_range_unsupported"),
        ] {
            let (ctx, _page, _) = context(format!("{base}/{path}"), Format::File, Some(128));
            assert_eq!(
                OriginReader::read_metadata(ctx, stopped.clone(), 10, 16)
                    .await
                    .unwrap_err()
                    .to_string(),
                error
            );
        }
        server.abort();
    }
    #[tokio::test]
    async fn failed_metadata_http_does_not_disclose_a_source_grant() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/media?grant=private",
            listener.local_addr().unwrap()
        );
        drop(listener);
        let (ctx, _page, _) = context(url.clone(), Format::File, Some(1000));
        let (_stop, stopped) = watch::channel(false);
        let error = OriginReader::read_metadata(ctx, stopped, 0, 16)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "watch_media_unavailable");
        assert!(error.downcast_ref::<reqwest::Error>().unwrap().is_connect());
        assert!(!format!("{error:?}").contains(&url));
        assert!(!format!("{error:?}").contains("grant=private"));
    }
    #[tokio::test]
    async fn request_failures_retain_timeout_and_redirect_causes_without_source_urls() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route(
                        "/slow",
                        get(|| async { std::future::pending::<String>().await }),
                    )
                    .route(
                        "/redirect",
                        get(|| async {
                            Response::builder()
                                .status(302)
                                .header("location", "/redirect?grant=private")
                                .body(Body::empty())
                                .unwrap()
                        }),
                    ),
            )
            .await
            .unwrap();
        });
        for (path, code) in [
            ("slow", "watch_media_timeout"),
            ("redirect", "watch_media_unavailable"),
        ] {
            let url = format!("{base}/{path}?grant=private");
            let error = reqwest::Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_millis(50))
                .redirect(reqwest::redirect::Policy::limited(1))
                .build()
                .unwrap()
                .get(&url)
                .send()
                .await
                .unwrap_err();
            let expected_timeout = error.is_timeout();
            let expected_redirect = error.is_redirect();
            let failure = request_failure(error);
            assert_eq!(failure.to_string(), code);
            let source = failure.downcast_ref::<reqwest::Error>().unwrap();
            assert_eq!(source.is_timeout(), expected_timeout);
            assert_eq!(source.is_redirect(), expected_redirect);
            assert!(source.url().is_none());
            assert!(!format!("{failure:?}").contains("grant=private"));
            if path == "slow" {
                assert!(source.is_timeout());
            } else {
                assert!(source.is_redirect());
            }
        }
        server.abort();
    }
    #[tokio::test]
    async fn metadata_reads_the_selected_origin_at_a_nonzero_range_without_registration() {
        let (base, server) = fixture().await;
        let (ctx, _page, _) = context(format!("{base}/big"), Format::File, Some(200 * 1024 * 1024));
        let (_stop, stopped) = watch::channel(false);
        let result = OriginReader::read_metadata(ctx, stopped, 65536, 65536)
            .await
            .unwrap();
        assert_eq!(result.total_size, Some(200 * 1024 * 1024));
        assert_eq!(result.bytes.len(), 65536);
        assert!(result
            .bytes
            .iter()
            .enumerate()
            .all(|(i, b)| *b == ((65536 + i) % 251) as u8));
        server.abort();
    }
    #[tokio::test]
    async fn file_ranges_validate_real_http_and_source_cancellation() {
        let (base, server) = fixture().await;
        let (ctx, page, _) = context(format!("{base}/big"), Format::File, Some(200 * 1024 * 1024));
        let (stop, stopped) = watch::channel(false);
        let reader = OriginReader::prepare(ctx, stopped).await.unwrap();
        let offset = 150 * 1024 * 1024;
        let data = reader.read(reader.root, offset, 65536).await.unwrap();
        assert_eq!(data.bytes.len(), 65536);
        assert_eq!(data.total_size, Some(200 * 1024 * 1024));
        assert!(!data.eof);
        assert!(data
            .bytes
            .iter()
            .enumerate()
            .all(|(i, b)| *b == ((offset + i as u64) % 251) as u8));
        let eof = reader
            .read(reader.root, 200 * 1024 * 1024, 65536)
            .await
            .unwrap();
        assert!(eof.eof && eof.bytes.is_empty());
        for path in ["ignore", "wrong", "short"] {
            let id = Uuid::new_v4();
            reader.resources.lock().await.insert(
                id,
                Resource::File {
                    url: url::Url::parse(&format!("{base}/{path}")).unwrap(),
                    size: None,
                },
            );
            assert!(reader.read(id, 10, 64).await.is_err(), "{path}");
        }
        let id = Uuid::new_v4();
        reader.resources.lock().await.insert(
            id,
            Resource::File {
                url: url::Url::parse(&format!("{base}/slow")).unwrap(),
                size: None,
            },
        );
        let work = reader.read(id, 0, 64);
        let cancel = async {
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            page.send_replace(true);
        };
        let (result, _) = tokio::join!(work, cancel);
        assert_eq!(result.unwrap_err().to_string(), "watch_source_retired");
        drop(stop);
        server.abort();
    }
    #[tokio::test]
    async fn vod_graph_rewrites_master_keys_maps_and_segments_to_admitted_ids() {
        let (base, server) = fixture().await;
        let (ctx, _page, _) = context(format!("{base}/master.m3u8"), Format::Hls, None);
        let (_stop, stopped) = watch::channel(false);
        let reader = OriginReader::prepare(ctx, stopped).await.unwrap();
        let root = reader.read(reader.root, 0, 65536).await.unwrap();
        let master = String::from_utf8(root.bytes).unwrap();
        assert!(!master.contains("vod.m3u8") && !master.contains(&base));
        let child = Uuid::parse_str(
            master
                .lines()
                .find(|l| !l.starts_with('#') && !l.is_empty())
                .unwrap(),
        )
        .unwrap();
        let media = reader.read(child, 0, 65536).await.unwrap();
        let media = String::from_utf8(media.bytes).unwrap();
        assert!(
            !media.contains("key.bin")
                && !media.contains("init.mp4")
                && !media.contains("segment.ts")
        );
        let segment = Uuid::parse_str(
            media
                .lines()
                .find(|l| !l.starts_with('#') && !l.is_empty())
                .unwrap(),
        )
        .unwrap();
        let bytes = reader.read(segment, 10, 64).await.unwrap();
        assert_eq!(bytes.bytes, (10..74).collect::<Vec<_>>());
        let ids = media
            .split("URI=\"")
            .skip(1)
            .map(|s| Uuid::parse_str(s.split('"').next().unwrap()).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(ids.len(), 2);
        for id in ids {
            assert!(!reader.read(id, 0, 64).await.unwrap().bytes.is_empty());
        }
        assert!(reader.read(Uuid::new_v4(), 0, 64).await.is_err());
        server.abort();
    }
    #[tokio::test]
    async fn observed_context_follows_same_origin_and_never_crosses_an_origin_boundary() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let foreign = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let foreign_url = format!("http://{}", foreign.local_addr().unwrap());
        let seen = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = seen.clone();
        let foreign_task = tokio::spawn(async move {
            axum::serve(
                foreign,
                Router::new().route(
                    "/file",
                    get(move |request: Request| {
                        let seen = observed.clone();
                        async move {
                            assert!(request.headers().get("referer").is_none());
                            assert!(request.headers().get("user-agent").is_none());
                            seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            origin(request).await
                        }
                    }),
                ),
            )
            .await
            .unwrap();
        });
        let source = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let source_url = format!("http://{}", source.local_addr().unwrap());
        let target = foreign_url.clone();
        let source_task = tokio::spawn(async move {
            axum::serve(
                source,
                Router::new().route(
                    "/{*path}",
                    get(move |request: Request| {
                        let target = target.clone();
                        async move {
                            assert_eq!(
                                request.headers().get("referer").unwrap(),
                                "https://page.test/"
                            );
                            assert_eq!(
                                request.headers().get("user-agent").unwrap(),
                                "Owned browser"
                            );
                            assert_eq!(request.headers().get("range").unwrap(), "bytes=0-15");
                            if request.uri().path() == "/same" || request.uri().path() == "/cross" {
                                let location = if request.uri().path() == "/same" {
                                    "/file".into()
                                } else {
                                    format!("{target}/file")
                                };
                                return Response::builder()
                                    .status(302)
                                    .header("location", location)
                                    .body(Body::empty())
                                    .unwrap();
                            }
                            origin(request).await
                        }
                    }),
                ),
            )
            .await
            .unwrap();
        });
        for (path, succeeds) in [("same", true), ("cross", false)] {
            let url = format!("{source_url}/{path}");
            let (mut ctx, _page, _) = context(url.clone(), Format::File, Some(128));
            ctx.request = Some(Arc::new(super::super::ObservedRequestContext {
                url: url::Url::parse(&url).unwrap(),
                referer: Some("https://page.test/".parse().unwrap()),
                user_agent: Some("Owned browser".parse().unwrap()),
            }));
            let (_stop, stopped) = watch::channel(false);
            let reader = OriginReader::new(ctx, stopped).unwrap();
            let result = reader.read(reader.root, 0, 16).await;
            if succeeds {
                assert_eq!(result.unwrap().bytes, (0..16).collect::<Vec<_>>());
            } else {
                assert_eq!(result.unwrap_err().to_string(), "watch_media_unavailable");
            }
            assert_eq!(seen.load(std::sync::atomic::Ordering::SeqCst), 0);
            let child = Uuid::new_v4();
            reader.resources.lock().await.insert(
                child,
                Resource::File {
                    url: url::Url::parse(&format!("{foreign_url}/file")).unwrap(),
                    size: Some(128),
                },
            );
            assert_eq!(
                reader.read(child, 0, 16).await.unwrap().bytes,
                (0..16).collect::<Vec<_>>()
            );
            seen.store(0, std::sync::atomic::Ordering::SeqCst);
        }
        source_task.abort();
        foreign_task.abort();
    }
    #[tokio::test]
    async fn redirects_keep_ranges_strip_credentials_and_resolve_hls_at_final_url() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let cdn = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let cdn_url = format!("http://{}", cdn.local_addr().unwrap());
        let seen = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = seen.clone();
        let cdn_task = tokio::spawn(async move {
            axum::serve(cdn, Router::new().route("/cdn/{*path}", get(move |request: Request| {
                let seen = observed.clone();
                async move {
                    assert!(request.headers().get("cookie").is_none());
                    assert!(request.headers().get("authorization").is_none());
                    assert!(request.headers().get("referer").is_none());
                    seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if request.uri().path() == "/cdn/root.m3u8" {
                        return Response::builder().body(Body::from("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.bin\n#EXT-X-ENDLIST\n")).unwrap();
                    }
                    origin(request).await
                }
            }))).await.unwrap();
        });
        let source = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let source_url = format!("http://{}", source.local_addr().unwrap());
        let target = cdn_url.clone();
        let source_task = tokio::spawn(async move {
            axum::serve(
                source,
                Router::new().route(
                    "/{*path}",
                    get(move |request: Request| {
                        let target = target.clone();
                        async move {
                            assert_eq!(
                                request.headers().get("cookie").unwrap(),
                                "owned=source-only"
                            );
                            let path = request.uri().path();
                            Response::builder()
                                .status(302)
                                .header("location", format!("{target}/cdn{path}"))
                                .body(Body::empty())
                                .unwrap()
                        }
                    }),
                ),
            )
            .await
            .unwrap();
        });
        for (path, format) in [("/file.mp4", Format::File), ("/root.m3u8", Format::Hls)] {
            let (mut ctx, _page, _) = context(
                format!("{source_url}{path}"),
                format,
                (format == Format::File).then_some(128),
            );
            ctx.cookies = Arc::new(|_| Box::pin(async { Ok(Some("owned=source-only".into())) }));
            let (_stop, stopped) = watch::channel(false);
            let reader = OriginReader::prepare(ctx, stopped).await.unwrap();
            if format == Format::File {
                let data = reader.read(reader.root, 12, 64).await.unwrap();
                assert_eq!(data.bytes, (12..76).collect::<Vec<_>>());
            } else {
                let root = reader.read(reader.root, 0, 65536).await.unwrap();
                let manifest = String::from_utf8(root.bytes).unwrap();
                assert!(!manifest.contains("http") && !manifest.contains("segment.bin"));
                let child = Uuid::parse_str(
                    manifest
                        .lines()
                        .find(|l| !l.is_empty() && !l.starts_with('#'))
                        .unwrap(),
                )
                .unwrap();
                match reader.resources.lock().await.get(&child).unwrap() {
                    Resource::File { url, .. } => {
                        assert_eq!(url.as_str(), format!("{cdn_url}/cdn/segment.bin"))
                    }
                    _ => panic!("expected media resource"),
                }
                assert_eq!(
                    reader.read(child, 0, 64).await.unwrap().bytes,
                    (0..64).collect::<Vec<_>>()
                );
            }
        }
        assert!(seen.load(std::sync::atomic::Ordering::SeqCst) >= 5);
        source_task.abort();
        cdn_task.abort();
    }

    #[test]
    fn unsupported_hls_is_explicit_and_long_vod_is_not_truncated() {
        let base = url::Url::parse("https://media.example/video/root.m3u8").unwrap();
        for content in ["#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\na.ts\n", "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"license\"\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST\n", "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI=\"private\"\n#EXT-X-ENDLIST\n"]{assert!(rewrite(content.as_bytes(),&base,&mut BTreeMap::new()).is_err());}
        let mut vod = String::from("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-CUSTOM:harmless\n");
        for i in 0..3600 {
            vod.push_str(&format!("#EXTINF:2,\n{i}.ts\n"));
        }
        vod.push_str("#EXT-X-ENDLIST\n");
        let mut resources = BTreeMap::new();
        let output = rewrite(vod.as_bytes(), &base, &mut resources).unwrap();
        assert_eq!(resources.len(), 3600);
        assert!(String::from_utf8(output)
            .unwrap()
            .contains("#EXT-CUSTOM:harmless"));
    }
}
