//! Origin reads remain inside a selected page lease; peers address admitted IDs only.
use super::{Format, MediaContext};
#[path = "mpd_native.rs"]
mod mpd_native;
use anyhow::{anyhow, bail, ensure, Result};
use piik_channel_core::watch_delivery::WATCH_WINDOW_BYTES;
use piik_channel_native::watch::{ReadResult, Reader};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{watch, Mutex};
use uuid::Uuid;

const MAX_MANIFEST: usize = piik_channel_core::watch_delivery::WATCH_MEDIA_MANIFEST_BYTES;
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
struct Snapshot {
    bytes: Arc<Vec<u8>>,
    live: bool,
    children: BTreeMap<Uuid, Duration>,
}
#[derive(Clone, Default)]
struct Retention {
    grace: Duration,
    until: Option<Instant>,
}
#[derive(Clone)]
enum Resource {
    Memory {
        bytes: Arc<Vec<u8>>,
        mime_type: String,
    },
    File {
        url: url::Url,
        size: Option<u64>,
        retention: Retention,
    },
    Playlist {
        url: url::Url,
        snapshot: Option<Snapshot>,
        reload: Arc<Mutex<()>>,
    },
}
pub struct OriginReader {
    pub root: Uuid,
    file_validator: std::sync::OnceLock<Option<(url::Url, reqwest::header::HeaderValue)>>,
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
        reader
            .read(
                root,
                0,
                if reader.context.format == Format::Hls {
                    WATCH_WINDOW_BYTES as u32
                } else {
                    1
                },
            )
            .await?;
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
                retention: Retention::default(),
            },
            Format::Hls | Format::Dash => Resource::Playlist {
                url,
                snapshot: None,
                reload: Arc::new(Mutex::new(())),
            },
        };
        let client = |policy| {
            reqwest::Client::builder()
                .redirect(policy)
                .referer(false)
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
            file_validator: Default::default(),
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
        ensure!(length > 0 && length as usize <= WATCH_WINDOW_BYTES, "invalid_watch_range");
        let resource = {
            let mut resources = self.resources.lock().await;
            maintain(&mut resources, Instant::now());
            resources
                .get(&id)
                .cloned()
                .ok_or_else(|| anyhow!("watch_resource_unavailable"))?
        };
        match resource {
            Resource::Memory { bytes, mime_type } => {
                let start = (offset as usize).min(bytes.len());
                let end = start.saturating_add(length as usize).min(bytes.len());
                Ok(ReadResult {
                    mime_type,
                    total_size: Some(bytes.len() as u64),
                    bytes: bytes[start..end].to_vec(),
                    eof: end == bytes.len(),
                })
            }
            Resource::Playlist {
                url,
                snapshot,
                reload,
            } => {
                ensure!(
                    !snapshot.as_ref().is_some_and(|s| s.live)
                        || (offset == 0 && length as usize == WATCH_WINDOW_BYTES),
                    "watch_live_hls_atomic_read_required"
                );
                let snapshot = match snapshot {
                    Some(snapshot) if !snapshot.live => snapshot,
                    _ => self.playlist(id, &url, reload).await?,
                };
                ensure!(
                    !snapshot.live || (offset == 0 && length as usize == WATCH_WINDOW_BYTES),
                    "watch_live_hls_atomic_read_required"
                );
                let bytes = snapshot.bytes;
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
            Resource::File {
                url,
                size,
                retention,
            } => {
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
                if id == self.root && self.context.format == Format::File {
                    let strong_tag = response.headers().get(reqwest::header::ETAG).filter(|v| {
                        matches!(v.as_bytes(), [b'"', opaque @ .., b'"'] if opaque.iter().all(|b| matches!(b, 0x21 | 0x23..=0x7e | 0x80..=0xff)))
                    });
                    let validator = self.file_validator.get_or_init(|| {
                        strong_tag.map(|tag| {
                            let mut owner = response.url().clone();
                            owner.set_fragment(None);
                            (owner, tag.clone())
                        })
                    });
                    if let Some((owner, tag)) = validator {
                        ensure!(
                            owner[..url::Position::AfterQuery]
                                == response.url()[..url::Position::AfterQuery]
                                && strong_tag == Some(tag),
                            "watch_media_unavailable"
                        );
                    }
                }
                if !retention.grace.is_zero() {
                    if let Some(Resource::File { size, .. }) =
                        self.resources.lock().await.get_mut(&id)
                    {
                        ensure!(
                            size.is_none_or(|known| known == total),
                            "watch_media_changed"
                        );
                        *size = Some(total);
                    }
                }
                Ok(ReadResult {
                    mime_type,
                    total_size: Some(total),
                    eof: offset + available == total,
                    bytes,
                })
            }
        }
    }
    async fn playlist(&self, id: Uuid, url: &url::Url, reload: Arc<Mutex<()>>) -> Result<Snapshot> {
        // Serialize only this manifest; other resources never wait on origin I/O.
        let _loading = reload.lock().await;
        let was_live = if let Some(Resource::Playlist {
            snapshot: Some(snapshot),
            ..
        }) = self.resources.lock().await.get(&id)
        {
            if !snapshot.live {
                return Ok(snapshot.clone());
            }
            true
        } else {
            false
        };
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
        while let Some(chunk) = response.chunk().await.map_err(request_failure)? {
            ensure!(
                bytes.len() + chunk.len() <= MAX_MANIFEST,
                "watch_manifest_limit"
            );
            bytes.extend_from_slice(&chunk);
        }
        let mut resources = self.resources.lock().await;
        maintain(&mut resources, Instant::now());
        // Validate/admit into a bounded transaction; failed rewrites leave the old graph intact.
        let mut next = resources.clone();
        let snapshot = rewrite(&bytes, &resolved_url, &mut next, was_live)?;
        let retained: usize = next
            .iter()
            .filter(|(key, _)| **key != id)
            .map(|(_, r)| match r {
                Resource::Playlist {
                    snapshot: Some(s), ..
                } => s.bytes.len(),
                _ => 0,
            })
            .sum();
        ensure!(
            retained + snapshot.bytes.len() <= 16 * 1024 * 1024,
            "watch_manifest_limit"
        );
        for (child, grace) in &snapshot.children {
            if let Some(Resource::File { retention, .. }) = next.get_mut(child) {
                retention.grace = retention.grace.max(*grace);
                retention.until = None;
            }
        }
        next.insert(
            id,
            Resource::Playlist {
                url: url.clone(),
                snapshot: Some(snapshot.clone()),
                reload: reload.clone(),
            },
        );
        maintain(&mut next, Instant::now());
        *resources = next;
        Ok(snapshot)
    }
}
impl Reader for OriginReader {
    fn read(
        &self,
        id: Uuid,
        offset: u64,
        length: u32,
    ) -> Pin<Box<dyn Future<Output = Result<ReadResult>> + Send + '_>> {
        Box::pin(self.source_operation(self.window(id, offset, length)))
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

fn maintain(resources: &mut BTreeMap<Uuid, Resource>, now: Instant) {
    let referenced: BTreeSet<_> = resources
        .values()
        .flat_map(|r| match r {
            Resource::Playlist {
                snapshot: Some(s), ..
            } => s.children.keys().copied().collect::<Vec<_>>(),
            _ => vec![],
        })
        .collect();
    resources.retain(|id, resource| {
        if let Resource::File { retention, .. } = resource {
            if !retention.grace.is_zero() && !referenced.contains(id) {
                let until = retention.until.get_or_insert_with(|| {
                    now.checked_add(retention.grace)
                        .expect("validated manifest duration")
                });
                return now < *until;
            }
        }
        true
    });
}

fn rewrite(
    bytes: &[u8],
    base: &url::Url,
    resources: &mut BTreeMap<Uuid, Resource>,
    was_live: bool,
) -> Result<Snapshot> {
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
                "#EXT-X-DEFINE"
                    | "#EXT-X-PART"
                    | "#EXT-X-PART-INF"
                    | "#EXT-X-SERVER-CONTROL"
                    | "#EXT-X-SKIP"
            ),
            "watch_manifest_extension_unsupported"
        );
    }
    let live = matches!(&playlist,Playlist::MediaPlaylist(media) if !media.end_list);
    let grace = if let Playlist::MediaPlaylist(media) = &playlist {
        if live || was_live {
            ensure!(
                text.lines()
                    .filter(|line| line.starts_with("#EXT-X-PROGRAM-DATE-TIME:"))
                    .count()
                    == media
                        .segments
                        .iter()
                        .filter(|s| s.program_date_time.is_some())
                        .count(),
                "watch_live_hls_timeline_unsupported"
            );
            let mut next_time = None;
            let mut anchored = false;
            for segment in &media.segments {
                ensure!(
                    segment.duration.is_finite() && segment.duration > 0.,
                    "watch_invalid_manifest"
                );
                if segment.discontinuity {
                    ensure!(
                        segment.program_date_time.is_some(),
                        "watch_live_hls_timeline_unsupported"
                    );
                }
                if let Some(pdt) = segment.program_date_time {
                    let at = pdt.timestamp_millis() as f64 / 1000.;
                    ensure!(
                        next_time.is_none_or(|previous: f64| at + 0.001 >= previous),
                        "watch_live_hls_timeline_unsupported"
                    );
                    next_time = Some(at);
                    anchored = true;
                }
                if let Some(at) = next_time {
                    next_time = Some(at + f64::from(segment.duration));
                }
            }
            ensure!(anchored, "watch_live_hls_timeline_unsupported");
            let window: f64 = media.segments.iter().map(|s| f64::from(s.duration)).sum();
            let longest = media
                .segments
                .iter()
                .map(|s| f64::from(s.duration))
                .fold(0., f64::max);
            {
                let grace = Duration::try_from_secs_f64(window + longest)
                    .map_err(|_| anyhow!("watch_invalid_manifest"))?;
                ensure!(
                    Instant::now().checked_add(grace).is_some(),
                    "watch_invalid_manifest"
                );
                grace
            }
        } else {
            Duration::ZERO
        }
    } else {
        Duration::ZERO
    };
    let mut children = BTreeMap::new();
    let mut pending = BTreeMap::new();
    let mut known: BTreeMap<String, Uuid> = resources
        .iter()
        .filter_map(|(id, r)| match r {
            Resource::Memory { .. } => None,
            Resource::File { url, .. } | Resource::Playlist { url, .. } => {
                Some((url.as_str().to_owned(), *id))
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
                    Resource::Playlist {
                        url,
                        snapshot: None,
                        reload: Arc::new(Mutex::new(())),
                    }
                } else {
                    Resource::File {
                        url,
                        size: None,
                        retention: Retention::default(),
                    }
                },
            );
            id
        };
        children.insert(id, grace);
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
    ensure!(
        !(live || was_live) || rewritten.len() <= WATCH_WINDOW_BYTES,
        "watch_manifest_limit"
    );
    resources.extend(pending);
    Ok(Snapshot {
        bytes: Arc::new(rewritten),
        live,
        children,
    })
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
            if path == "/redirect-version" {
                let target = if start < 2 {
                    "/object?a#one"
                } else {
                    "/object?b#two"
                };
                return Response::builder()
                    .status(307)
                    .header("location", target)
                    .body(Body::empty())
                    .unwrap();
            }
            if path == "/object" {
                let byte = if request.uri().query() == Some("a") {
                    1
                } else {
                    2
                };
                return response
                    .header("etag", r#""same""#)
                    .header("content-range", format!("bytes {start}-{end}/{size}"))
                    .body(Body::from(vec![byte; bytes.len()]))
                    .unwrap();
            }
            if matches!(path, "/weak" | "/absent") {
                assert!(request.headers().get("if-match").is_none());
                if start > 0 {
                    response = response.header("etag", format!(r#""{start}""#));
                } else if path == "/weak" {
                    response = response.header("etag", r#"W/"weak""#);
                }
            }
            if path == "/replace" {
                assert!(request.headers().get("if-match").is_none());
                let tag = if start < 2 { r#""a""# } else { r#""b""# };
                return response
                    .header("etag", tag)
                    .header("content-range", format!("bytes {start}-{end}/{size}"))
                    .body(Body::from(vec![if start < 2 { 1 } else { 2 }; bytes.len()]))
                    .unwrap();
            }
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

    #[derive(Default)]
    struct LiveOrigin {
        file_size: std::sync::atomic::AtomicU64,
        sequence: std::sync::atomic::AtomicUsize,
        ended: std::sync::atomic::AtomicBool,
        status: std::sync::atomic::AtomicU16,
        reads: std::sync::atomic::AtomicUsize,
        slow_manifest: std::sync::atomic::AtomicBool,
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }
    async fn live_fixture() -> (String, Arc<LiveOrigin>, tokio::task::JoinHandle<()>) {
        use std::sync::atomic::Ordering::SeqCst;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(LiveOrigin::default());
        let observed = state.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener,Router::new().route("/{*path}",get(move |request:Request| {
                let state=observed.clone();async move {
                    let path=request.uri().path();
                    if path.ends_with(".m3u8") {
                        state.reads.fetch_add(1,SeqCst);
                        if path=="/live.m3u8" && state.slow_manifest.load(SeqCst) {
                            state.entered.notify_one();state.release.notified().await;
                        }
                        let status=state.status.load(SeqCst);
                        if status!=0 {return Response::builder().status(status).body(Body::empty()).unwrap();}
                        let sequence=if path=="/other.m3u8" {0} else {state.sequence.load(SeqCst)};
                        let tail=if state.ended.load(SeqCst) {"#EXT-X-ENDLIST\n"} else {""};
                        return Response::builder().header("content-type","application/vnd.apple.mpegurl").body(Body::from(format!(
                            "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:{sequence}\n#EXT-X-PROGRAM-DATE-TIME:2026-11-15T00:00:{:02}Z\n#EXTINF:2,\ns{sequence}.ts\n#EXTINF:2,\ns{}.ts\n{tail}",sequence*2,sequence+1))).unwrap();
                    }
                    if path=="/s0.ts" && state.slow_manifest.load(SeqCst) {
                        state.entered.notify_one();state.release.notified().await;
                    }
                    let size=state.file_size.load(SeqCst);
                    if size>0 {
                        let range=request.headers().get("range").unwrap().to_str().unwrap().strip_prefix("bytes=").unwrap();
                        let (start,end)=range.split_once('-').unwrap();let start=start.parse::<u64>().unwrap();let end=end.parse::<u64>().unwrap().min(size-1);
                        return Response::builder().status(206).header("content-type","video/mp2t").header("content-range",format!("bytes {start}-{end}/{size}"))
                            .body(Body::from(vec![1u8;(end-start+1)as usize])).unwrap();
                    }
                    origin(request).await
                }
            }))).await.unwrap();
        });
        (base, state, server)
    }
    fn segment_ids(bytes: &[u8]) -> Vec<Uuid> {
        String::from_utf8_lossy(bytes)
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .map(|line| Uuid::parse_str(line).unwrap())
            .collect()
    }
    #[tokio::test]
    async fn live_refresh_is_atomic_bounded_shared_and_freezes_at_endlist() {
        use std::sync::atomic::Ordering::SeqCst;
        let (base, state, server) = live_fixture().await;
        let (ctx, _page, _) = context(format!("{base}/live.m3u8"), Format::Hls, None);
        let (_stop, stopped) = watch::channel(false);
        let reader = OriginReader::prepare(ctx, stopped).await.unwrap();
        let first = reader.read(reader.root, 0, 65536).await.unwrap();
        assert!(first.eof);
        assert_eq!(first.total_size, Some(first.bytes.len() as u64));
        let old = segment_ids(&first.bytes);
        assert_eq!(
            reader
                .read(reader.root, 0, 1)
                .await
                .unwrap_err()
                .to_string(),
            "watch_live_hls_atomic_read_required"
        );
        let sibling = Uuid::new_v4();
        reader.resources.lock().await.insert(
            sibling,
            Resource::Playlist {
                url: url::Url::parse(&format!("{base}/other.m3u8")).unwrap(),
                snapshot: None,
                reload: Arc::new(Mutex::new(())),
            },
        );
        let other = reader.read(sibling, 0, 65536).await.unwrap();
        assert_eq!(segment_ids(&other.bytes), old);
        state.sequence.store(1, SeqCst);
        let next = reader.read(reader.root, 0, 65536).await.unwrap();
        let current = segment_ids(&next.bytes);
        assert_eq!(old[1], current[0]);
        assert_ne!(first.bytes, next.bytes);
        assert!(!reader.read(old[0], 0, 32).await.unwrap().bytes.is_empty());
        // Another rendition's current window keeps the same exact resource alive.
        maintain(
            &mut *reader.resources.lock().await,
            Instant::now() + Duration::from_secs(60),
        );
        assert!(reader.resources.lock().await.contains_key(&old[0]));
        reader.resources.lock().await.remove(&sibling);
        {
            let mut graph = reader.resources.lock().await;
            maintain(&mut graph, Instant::now());
            let Resource::File { retention, .. } = &graph[&old[0]] else {
                panic!()
            };
            assert_eq!(retention.grace, Duration::from_secs(6));
            maintain(&mut graph, Instant::now() + Duration::from_secs(7));
        }
        assert_eq!(
            reader.read(old[0], 0, 1).await.unwrap_err().to_string(),
            "watch_resource_unavailable"
        );
        for sequence in 2..30 {
            state.sequence.store(sequence, SeqCst);
            let read = reader.read(reader.root, 0, 65536).await.unwrap();
            assert!(read.eof);
            maintain(
                &mut *reader.resources.lock().await,
                Instant::now() + Duration::from_secs(60),
            );
            assert!(reader.resources.lock().await.len() <= 3);
        }
        state.ended.store(true, SeqCst);
        let final_bytes = reader.read(reader.root, 0, 65536).await.unwrap().bytes;
        let fetched = state.reads.load(SeqCst);
        state.sequence.store(100, SeqCst);
        assert_eq!(
            reader.read(reader.root, 0, 65536).await.unwrap().bytes,
            final_bytes
        );
        assert_eq!(state.reads.load(SeqCst), fetched);
        server.abort();
    }
    #[tokio::test]
    async fn live_origin_failure_is_visible_and_reload_never_blocks_segments_or_retirement() {
        use std::sync::atomic::Ordering::SeqCst;
        let (base, state, server) = live_fixture().await;
        let (ctx, page, _) = context(format!("{base}/live.m3u8"), Format::Hls, None);
        let (_stop, stopped) = watch::channel(false);
        let reader = OriginReader::prepare(ctx, stopped).await.unwrap();
        let old = segment_ids(&reader.read(reader.root, 0, 65536).await.unwrap().bytes);
        for code in [404, 410] {
            state.status.store(code, SeqCst);
            assert!(reader.read(reader.root, 0, 65536).await.is_err());
            assert!(reader.resources.lock().await.contains_key(&old[0]));
        }
        state.status.store(0, SeqCst);
        reader.read(old[1], 0, 32).await.unwrap();
        state.file_size.store(129, SeqCst);
        assert!(
            reader.read(old[1], 0, 32).await.is_err(),
            "a growing file cannot change total size under one admitted resource"
        );
        state.file_size.store(0, SeqCst);
        state.slow_manifest.store(true, SeqCst);
        let reading = reader.clone();
        let reload = tokio::spawn(async move { reading.read(reading.root, 0, 65536).await });
        state.entered.notified().await;
        // Unrelated segment I/O proceeds while the manifest is held at the origin.
        tokio::time::timeout(Duration::from_secs(1), reader.read(old[1], 0, 32))
            .await
            .unwrap()
            .unwrap();
        page.send_replace(true);
        assert_eq!(
            reload.await.unwrap().unwrap_err().to_string(),
            "watch_source_retired"
        );
        server.abort();
    }
    #[tokio::test]
    async fn admitted_segment_read_survives_graph_expiry() {
        use std::sync::atomic::Ordering::SeqCst;
        let (base, state, server) = live_fixture().await;
        let (ctx, _page, _) = context(format!("{base}/live.m3u8"), Format::Hls, None);
        let (_stop, stopped) = watch::channel(false);
        let reader = OriginReader::prepare(ctx, stopped).await.unwrap();
        let old = segment_ids(&reader.read(reader.root, 0, 65536).await.unwrap().bytes)[0];
        state.slow_manifest.store(true, SeqCst);
        let reading = reader.clone();
        let segment = tokio::spawn(async move { reading.read(old, 0, 32).await });
        state.entered.notified().await;
        state.slow_manifest.store(false, SeqCst);
        state.sequence.store(2, SeqCst);
        reader.read(reader.root, 0, 65536).await.unwrap();
        maintain(
            &mut *reader.resources.lock().await,
            Instant::now() + Duration::from_secs(60),
        );
        assert!(!reader.resources.lock().await.contains_key(&old));
        state.release.notify_one();
        assert_eq!(
            segment.await.unwrap().unwrap().bytes,
            (0..32).collect::<Vec<_>>()
        );
        server.abort();
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
    async fn progressing_http_range_has_no_independent_total_deadline() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/progress", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/progress", get(|| async {
                let body = futures_util::stream::unfold(0u8, |index| async move {
                    if index == 3 { return None; }
                    if index > 0 { tokio::time::sleep(Duration::from_secs(8)).await; }
                    Some((Ok::<_, std::io::Error>(axum::body::Bytes::from(vec![index])), index + 1))
                });
                Response::builder().status(206).header("content-range", "bytes 0-2/3")
                    .header("content-length", 3).body(Body::from_stream(body)).unwrap()
            }))).await.unwrap();
        });
        let (context, _page, _) = context(url, Format::File, Some(3));
        let (_stop, stopped) = watch::channel(false);
        let started = Instant::now();
        let result = tokio::time::timeout(Duration::from_secs(19),
            OriginReader::read_metadata(context, stopped, 0, 3)).await;
        server.abort(); let _ = server.await;
        println!("progressing HTTP range completed after {:?}", started.elapsed());
        assert_eq!(result.unwrap().unwrap().bytes, vec![0, 1, 2]);
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
    async fn selected_file_rejects_replacement() {
        let (base, server) = fixture().await;
        let (ctx, _page, _) = context(format!("{base}/./replace#local"), Format::File, Some(128));
        let (_stop, stopped) = watch::channel(false);
        let reader = OriginReader::prepare(ctx, stopped).await.unwrap();
        assert_eq!(reader.read(reader.root, 0, 2).await.unwrap().bytes, [1, 1]);
        assert_eq!(
            reader
                .read(reader.root, 2, 2)
                .await
                .err()
                .unwrap()
                .to_string(),
            "watch_media_unavailable"
        );
        server.abort();
    }
    #[tokio::test]
    async fn selected_file_scopes_validator_to_final_url_and_first_accepted_read() {
        let (base, server) = fixture().await;
        for path in ["redirect-version", "weak", "absent"] {
            let (ctx, _page, _) = context(format!("{base}/{path}"), Format::File, Some(128));
            let (_stop, stopped) = watch::channel(false);
            let reader = OriginReader::prepare(ctx, stopped).await.unwrap();
            let read = reader.read(reader.root, 2, 2).await;
            if path == "redirect-version" {
                assert_eq!(read.err().unwrap().to_string(), "watch_media_unavailable");
            } else {
                assert_eq!(read.unwrap().bytes, [2, 3]);
            }
        }
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
                    retention: Retention::default(),
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
                retention: Retention::default(),
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
                    retention: Retention::default(),
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
    fn live_mapping_and_atomic_size_are_admission_bounds() {
        let base = url::Url::parse("https://owned.test/live.m3u8").unwrap();
        for content in [
            "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\na.ts\n",
            "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PROGRAM-DATE-TIME:broken\n#EXTINF:2,\na.ts\n",
            "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PROGRAM-DATE-TIME:2026-11-15T00:00:00Z\n#EXTINF:2,\na.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\nb.ts\n",
            "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PROGRAM-DATE-TIME:2026-11-15T00:00:02Z\n#EXTINF:2,\na.ts\n#EXT-X-PROGRAM-DATE-TIME:2026-11-15T00:00:01Z\n#EXTINF:2,\nb.ts\n",
        ] {
            let content=content.replace("\\n","\n");
            assert!(rewrite(content.as_bytes(),&base,&mut BTreeMap::new(),false).is_err());
        }
        let mut large = String::from(
            "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PROGRAM-DATE-TIME:2026-11-15T00:00:00Z\n",
        );
        for i in 0..1800 {
            large.push_str(&format!("#EXTINF:2,\n{i}.ts\n"));
        }
        assert!(rewrite(large.as_bytes(), &base, &mut BTreeMap::new(), false).is_err());
        large.push_str("#EXT-X-ENDLIST\n");
        assert!(
            rewrite(large.as_bytes(), &base, &mut BTreeMap::new(), false).is_ok(),
            "static VOD keeps its larger immutable path"
        );
        assert!(
            rewrite(large.as_bytes(), &base, &mut BTreeMap::new(), true).is_err(),
            "the final live snapshot retains its atomic admission bound"
        );
    }
    #[test]
    fn unsupported_hls_is_explicit_and_long_vod_is_not_truncated() {
        let base = url::Url::parse("https://media.example/video/root.m3u8").unwrap();
        for content in ["#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\na.ts\n", "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"license\"\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST\n", "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI=\"private\"\n#EXT-X-ENDLIST\n"]{assert!(rewrite(content.as_bytes(),&base,&mut BTreeMap::new(),false).is_err());}
        let mut vod = String::from("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-CUSTOM:harmless\n");
        for i in 0..3600 {
            vod.push_str(&format!("#EXTINF:2,\n{i}.ts\n"));
        }
        vod.push_str("#EXT-X-ENDLIST\n");
        let mut resources = BTreeMap::new();
        let output = rewrite(vod.as_bytes(), &base, &mut resources, false).unwrap();
        assert_eq!(resources.len(), 3600);
        assert!(String::from_utf8(output.bytes.as_ref().clone())
            .unwrap()
            .contains("#EXT-CUSTOM:harmless"));
    }
}
