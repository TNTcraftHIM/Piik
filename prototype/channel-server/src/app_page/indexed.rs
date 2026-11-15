//! Compose explicitly selected indexed files; GPAC in the shared Web owns MP4 parsing.
use super::{reader::OriginReader, Format, MediaContext};
use anyhow::{anyhow, bail, ensure, Result};
use base64ct::{Base64, Encoding};
use piik_channel_native::watch::{ReadResult, Reader};
use serde::Deserialize;
use std::{collections::BTreeMap, future::Future, pin::Pin, sync::Arc};
use tokio::sync::watch;
use uuid::Uuid;

const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_FRAGMENT: u64 = 60_000_000;
const MAX_INIT: usize = 1024 * 1024;
const MAX_PLAYLIST: usize = 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackRecipe {
    pub choice_id: Uuid,
    pub total_size: u64,
    pub codec: String,
    pub timescale: u32,
    pub media_offset: u64,
    pub init_base64: String,
    pub segments: Vec<(u64, u32)>,
}
impl TrackRecipe {
    fn validate(&self) -> Result<Vec<u8>> {
        ensure!(
            !self.codec.is_empty()
                && self.codec.len() <= 128
                && self.codec.bytes().all(
                    |byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`{|}~".contains(&byte)
                ),
            "invalid_watch_index"
        );
        ensure!(
            self.total_size > 0
                && self.total_size <= SAFE_INTEGER
                && self.timescale > 0
                && self.media_offset <= self.total_size
                && !self.segments.is_empty()
                && self.segments.len() <= u16::MAX as usize,
            "invalid_watch_index"
        );
        let mut end = self.media_offset;
        let mut ticks = 0u64;
        for &(length, duration) in &self.segments {
            ensure!(
                length > 0 && length <= MAX_FRAGMENT && duration > 0,
                "invalid_watch_index"
            );
            end = end
                .checked_add(length)
                .ok_or_else(|| anyhow!("invalid_watch_index"))?;
            ticks = ticks
                .checked_add(u64::from(duration))
                .ok_or_else(|| anyhow!("invalid_watch_index"))?;
            ensure!(
                end <= self.total_size && ticks <= SAFE_INTEGER,
                "invalid_watch_index"
            );
        }
        ensure!(
            !self.init_base64.is_empty() && self.init_base64.len() <= MAX_INIT.div_ceil(3) * 4,
            "invalid_watch_index"
        );
        let init =
            Base64::decode_vec(&self.init_base64).map_err(|_| anyhow!("invalid_watch_index"))?;
        ensure!(
            !init.is_empty() && init.len() <= MAX_INIT,
            "invalid_watch_index"
        );
        Ok(init)
    }
    fn bandwidth(&self) -> u64 {
        self.segments
            .iter()
            .map(|&(length, ticks)| {
                (u128::from(length) * 8 * u128::from(self.timescale)).div_ceil(u128::from(ticks))
                    as u64
            })
            .max()
            .unwrap()
    }
}

enum Resource {
    Bytes { mime: &'static str, bytes: Vec<u8> },
    File(Arc<OriginReader>),
}
pub struct IndexedReader {
    pub root: Uuid,
    resources: BTreeMap<Uuid, Resource>,
    retired: watch::Receiver<bool>,
    stopped: watch::Receiver<bool>,
}
impl IndexedReader {
    pub async fn prepare(
        video: (TrackRecipe, MediaContext),
        audio: Option<(TrackRecipe, MediaContext)>,
        stopped: watch::Receiver<bool>,
    ) -> Result<Arc<Self>> {
        ensure!(
            audio
                .as_ref()
                .is_none_or(|(recipe, _)| recipe.choice_id != video.0.choice_id),
            "invalid_watch_index"
        );
        let mut reader = Self {
            root: Uuid::new_v4(),
            resources: BTreeMap::new(),
            retired: video.1.retired.clone(),
            stopped,
        };
        let (video_playlist, video_bandwidth, video_codec) =
            reader.add_track(video.0, video.1).await?;
        let mut master = m3u8_rs::MasterPlaylist {
            version: Some(7),
            ..Default::default()
        };
        let mut variant = m3u8_rs::VariantStream {
            uri: video_playlist.to_string(),
            bandwidth: video_bandwidth,
            codecs: Some(video_codec),
            ..Default::default()
        };
        if let Some((recipe, context)) = audio {
            let (playlist, bandwidth, codec) = reader.add_track(recipe, context).await?;
            variant.bandwidth = variant
                .bandwidth
                .checked_add(bandwidth)
                .ok_or_else(|| anyhow!("invalid_watch_index"))?;
            variant.codecs = Some(format!("{},{}", variant.codecs.unwrap(), codec));
            variant.audio = Some("audio".into());
            master.alternatives.push(m3u8_rs::AlternativeMedia {
                media_type: m3u8_rs::AlternativeMediaType::Audio,
                uri: Some(playlist.to_string()),
                group_id: "audio".into(),
                name: "Audio".into(),
                default: true,
                autoselect: true,
                ..Default::default()
            });
        }
        master.variants.push(variant);
        let mut bytes = vec![];
        master.write_to(&mut bytes)?;
        reader.resources.insert(
            reader.root,
            Resource::Bytes {
                mime: "application/vnd.apple.mpegurl",
                bytes,
            },
        );
        ensure!(
            !*reader.stopped.borrow() && !*reader.retired.borrow(),
            "watch_source_retired"
        );
        Ok(Arc::new(reader))
    }
    async fn add_track(
        &mut self,
        recipe: TrackRecipe,
        context: MediaContext,
    ) -> Result<(Uuid, u64, String)> {
        let init = recipe.validate()?;
        ensure!(
            context.format == Format::File && context.size == Some(recipe.total_size),
            "watch_media_changed"
        );
        let origin = OriginReader::prepare(context, self.stopped.clone()).await?;
        // Prove a media Range, not only the file prefix, before publishing this graph.
        origin.read(origin.root, recipe.media_offset, 1).await?;
        let file = origin.root;
        let init_id = Uuid::new_v4();
        let playlist_id = Uuid::new_v4();
        let bytes = track_playlist(&recipe, file, init_id)?;
        self.resources.insert(file, Resource::File(origin));
        self.resources.insert(
            init_id,
            Resource::Bytes {
                mime: "video/mp4",
                bytes: init,
            },
        );
        self.resources.insert(
            playlist_id,
            Resource::Bytes {
                mime: "application/vnd.apple.mpegurl",
                bytes,
            },
        );
        Ok((playlist_id, recipe.bandwidth(), recipe.codec))
    }
    async fn window(&self, id: Uuid, offset: u64, length: u32) -> Result<ReadResult> {
        ensure!(length > 0 && length <= 65536, "invalid_watch_range");
        match self
            .resources
            .get(&id)
            .ok_or_else(|| anyhow!("watch_resource_unavailable"))?
        {
            Resource::File(reader) => reader.read(id, offset, length).await,
            Resource::Bytes { mime, bytes } => {
                let start = usize::try_from(offset)
                    .unwrap_or(usize::MAX)
                    .min(bytes.len());
                let end = start.saturating_add(length as usize).min(bytes.len());
                Ok(ReadResult {
                    mime_type: (*mime).into(),
                    total_size: Some(bytes.len() as u64),
                    bytes: bytes[start..end].to_vec(),
                    eof: end == bytes.len(),
                })
            }
        }
    }
}
impl Reader for IndexedReader {
    fn read(
        &self,
        id: Uuid,
        offset: u64,
        length: u32,
    ) -> Pin<Box<dyn Future<Output = Result<ReadResult>> + Send + '_>> {
        Box::pin(async move {
            let mut retired = self.retired.clone();
            let mut stopped = self.stopped.clone();
            tokio::select! { biased;
                _ = stopped.wait_for(|value| *value) => bail!("watch_source_retired"),
                _ = retired.wait_for(|value| *value) => bail!("watch_source_retired"),
                result = self.window(id, offset, length) => result,
            }
        })
    }
}
fn track_playlist(recipe: &TrackRecipe, file: Uuid, init: Uuid) -> Result<Vec<u8>> {
    let mut playlist = m3u8_rs::MediaPlaylist {
        version: Some(7),
        end_list: true,
        playlist_type: Some(m3u8_rs::MediaPlaylistType::Vod),
        target_duration: recipe
            .segments
            .iter()
            .map(|&(_, ticks)| u64::from(ticks).div_ceil(u64::from(recipe.timescale)))
            .max()
            .unwrap(),
        ..Default::default()
    };
    let mut offset = recipe.media_offset;
    for (index, &(length, ticks)) in recipe.segments.iter().enumerate() {
        playlist.segments.push(m3u8_rs::MediaSegment {
            uri: file.to_string(),
            duration: ticks as f32 / recipe.timescale as f32,
            byte_range: Some(m3u8_rs::ByteRange {
                length,
                offset: Some(offset),
            }),
            map: (index == 0).then(|| m3u8_rs::Map {
                uri: init.to_string(),
                ..Default::default()
            }),
            ..Default::default()
        });
        offset += length;
    }
    let mut bytes = vec![];
    playlist.write_to(&mut bytes)?;
    ensure!(bytes.len() <= MAX_PLAYLIST, "watch_manifest_limit");
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn recipe() -> TrackRecipe {
        TrackRecipe {
            choice_id: Uuid::new_v4(),
            total_size: 1000,
            codec: "av01.0.08M.08".into(),
            timescale: 1000,
            media_offset: 100,
            init_base64: Base64::encode_string(b"normalized init"),
            segments: vec![(200, 2001), (300, 1999)],
        }
    }
    #[test]
    fn playlist_preserves_original_offsets_and_track_durations() {
        let recipe = recipe();
        recipe.validate().unwrap();
        let file = Uuid::new_v4();
        let init = Uuid::new_v4();
        let bytes = track_playlist(&recipe, file, init).unwrap();
        let (_, parsed) = m3u8_rs::parse_playlist(&bytes).unwrap();
        let m3u8_rs::Playlist::MediaPlaylist(parsed) = parsed else {
            panic!()
        };
        assert_eq!(parsed.target_duration, 3);
        assert_eq!(
            parsed.segments[0].map.as_ref().unwrap().uri,
            init.to_string()
        );
        for (segment, offset) in parsed.segments.iter().zip([100, 300]) {
            assert_eq!(segment.uri, file.to_string());
            assert_eq!(segment.byte_range.as_ref().unwrap().offset, Some(offset));
        }
        assert!((parsed.segments[0].duration - 2.001).abs() < 0.0001);
        assert!((parsed.segments[1].duration - 1.999).abs() < 0.0001);
    }
    #[test]
    fn recipe_rejects_out_of_file_ranges_and_fragment_bloat() {
        let mut value = recipe();
        value.segments[1].0 = 701;
        assert!(value.validate().is_err());
        let mut value = recipe();
        value.total_size = SAFE_INTEGER;
        value.segments[0].0 = MAX_FRAGMENT + 1;
        assert!(value.validate().is_err());
        let mut value = recipe();
        value.codec = "av01.0\nURI=secret".into();
        assert!(value.validate().is_err());
        for codec in ["opus", "flac", "vendor-codec", "opaque!#$%&'*+-.^_`{|}~"] {
            let mut value = recipe();
            value.codec = codec.into();
            assert!(value.validate().is_ok());
        }
        let mut value = recipe();
        value.timescale = 0;
        assert!(value.validate().is_err());
    }
}
