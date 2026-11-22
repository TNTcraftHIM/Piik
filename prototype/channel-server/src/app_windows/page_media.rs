//! Response facts are intersected with the selected frame's observed resources.
use crate::app::page::{self, Format};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::{BTreeMap, VecDeque},
    rc::Rc,
};
use tokio::sync::{oneshot, watch};
use uuid::Uuid;
use webview2_com::{
    GetCookiesCompletedHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2_2,
    WebResourceResponseReceivedEventHandler,
};
use windows_core::{Interface, PCWSTR, PWSTR};
use wry::{WebView, WebViewExtWindows};

#[derive(Clone)]
pub struct Choice {
    pub request: Option<std::sync::Arc<page::ObservedRequestContext>>,
    pub id: Uuid,
    pub url: String,
    pub format: Format,
    pub size: Option<u64>,
    mime_type: String,
    direct: bool,
    indexed: bool,
}
type ResponseFact = (
    Format,
    Option<u64>,
    String,
    Option<std::sync::Arc<page::ObservedRequestContext>>,
);
#[derive(Default)]
struct Frame {
    ancestors: Vec<Uuid>,
    resources: VecDeque<String>,
    pending: VecDeque<String>,
}
impl Choice {
    pub fn source_url(&self) -> &str {
        self.request
            .as_ref()
            .map(|request| request.url.as_str())
            .unwrap_or(&self.url)
    }
}
pub struct Media {
    observed: VecDeque<(String, ResponseFact)>,
    redirects: VecDeque<(String, String)>,
    frames: BTreeMap<Uuid, Frame>,
    choices: BTreeMap<Uuid, Choice>,
    // Last requested projection; Page remains the authority for the selected frame.
    observation: Option<(Uuid, String, Value)>,
    pub retired: watch::Sender<bool>,
}
impl Default for Media {
    fn default() -> Self {
        Self {
            observed: VecDeque::new(),
            redirects: VecDeque::new(),
            frames: BTreeMap::new(),
            choices: BTreeMap::new(),
            observation: None,
            retired: watch::channel(false).0,
        }
    }
}
impl Drop for Media {
    fn drop(&mut self) {
        self.retired.send_replace(true);
    }
}
impl Media {
    pub fn reset(&mut self) {
        self.retired.send_replace(true);
        *self = Self::default();
    }
    pub fn clear_selection(&mut self) {
        self.retired.send_replace(true);
        self.retired = watch::channel(false).0;
        self.observation = None;
        self.choices.clear();
    }
    pub fn frame(&mut self, id: Uuid, ancestors: Vec<Uuid>, urls: Vec<String>) -> bool {
        if self.frames.len() >= 64 && !self.frames.contains_key(&id) {
            return false;
        }
        let frame = self.frames.entry(id).or_default();
        frame.ancestors = ancestors;
        for url in urls.into_iter().filter(|v| page::valid_url(v)).take(128) {
            if !frame.resources.contains(&url) {
                frame.pending.retain(|old| old != &url);
                frame.pending.push_back(url);
                if frame.pending.len() > 128 {
                    frame.pending.pop_front();
                }
            }
        }
        self.match_frames()
    }
    pub fn remove_frame(&mut self, id: Uuid) {
        if self.observation.as_ref().is_some_and(|(frame, _, _)| {
            *frame == id
                || self
                    .frames
                    .get(frame)
                    .is_some_and(|state| state.ancestors.contains(&id))
        }) {
            self.observation = None;
            self.choices.clear();
        }
        self.frames
            .retain(|frame, state| *frame != id && !state.ancestors.contains(&id));
    }
    fn observe_response(&mut self, url: String, fact: ResponseFact) -> bool {
        self.redirects.retain(|(old, _)| old != &url);
        self.observed.retain(|(old, _)| old != &url);
        if self.observed.len() >= 128 {
            // Preserve discovered manifests as later segment responses arrive.
            let Some(index) = self
                .observed
                .iter()
                .position(|(_, fact)| fact.0 == Format::File)
            else {
                return self.match_frames();
            };
            self.observed.remove(index);
        }
        self.observed.push_back((url, fact));
        self.match_frames()
    }
    fn observe_redirect(&mut self, url: String, target: String) -> bool {
        self.observed.retain(|(old, _)| old != &url);
        self.redirects.retain(|(old, _)| old != &url);
        if self.redirects.len() >= 128 {
            let Some(index) = self
                .redirects
                .iter()
                .position(|(url, _)| !self.is_playlist(url))
            else {
                return self.match_frames();
            };
            self.redirects.remove(index);
        }
        self.redirects.push_back((url, target));
        self.match_frames()
    }
    fn is_playlist(&self, url: &str) -> bool {
        self.response(url)
            .is_some_and(|fact| fact.0 != Format::File)
    }
    fn match_frames(&mut self) -> bool {
        let mut frames = std::mem::take(&mut self.frames);
        for frame in frames.values_mut() {
            frame.resources.retain(|url| {
                self.response(url).is_some() || self.redirects.iter().any(|(alias, _)| alias == url)
            });
            let mut unmatched = VecDeque::new();
            for url in frame.pending.drain(..) {
                if self.response(&url).is_none() {
                    unmatched.push_back(url);
                    continue;
                }
                if frame.resources.len() >= 128 {
                    let Some(index) = frame
                        .resources
                        .iter()
                        .position(|url| !self.is_playlist(url))
                    else {
                        continue;
                    };
                    frame.resources.remove(index);
                }
                frame.resources.push_back(url);
            }
            frame.pending = unmatched;
        }
        self.frames = frames;
        let Some((frame, current, previous)) = self.observation.take() else {
            return false;
        };
        self.sources(frame, &current) != previous
    }
    fn response<'a>(&'a self, mut url: &'a str) -> Option<ResponseFact> {
        // Join observed response facts; HTTP redirects themselves remain owned by reqwest.
        for _ in 0..=10 {
            if let Some((_, fact)) = self.observed.iter().find(|(key, _)| key == url) {
                return Some(fact.clone());
            }
            url = &self.redirects.iter().find(|(key, _)| key == url)?.1;
        }
        None
    }
    pub fn sources(&mut self, frame: Uuid, current: &str) -> Value {
        let value = self.project_sources(frame, current);
        self.observation = Some((frame, current.to_owned(), value.clone()));
        value
    }
    fn project_sources(&mut self, frame: Uuid, current: &str) -> Value {
        let mut found: BTreeMap<String, (Format, Option<u64>, String, bool, bool)> =
            BTreeMap::new();
        if let Some((format, size, mime, _)) = self.response(current) {
            if format == Format::Hls || format == Format::Dash || size.is_some() {
                found.insert(current.to_owned(), (format, size, mime, true, false));
            }
        }
        if let Some(frame) = self.frames.get(&frame) {
            for url in &frame.resources {
                if let Some((format, size, mime, _)) = self.response(url) {
                    let direct = format == Format::Hls || format == Format::Dash;
                    let indexed = format == Format::File
                        && size.is_some_and(|size| size > 0 && size <= 9_007_199_254_740_991);
                    if direct || indexed {
                        let entry = found
                            .entry(url.clone())
                            .or_insert((format, size, mime, false, false));
                        entry.3 |= direct;
                        entry.4 |= indexed;
                    }
                }
            }
        }
        self.choices
            .retain(|_, choice| found.contains_key(&choice.url));
        for choice in self.choices.values_mut() {
            choice.direct = false;
            choice.indexed = false;
        }
        let mut direct_count = 0;
        let mut indexed_count = 0;
        let mut found: Vec<_> = found.into_iter().collect();
        found.sort_by_key(|(url, _)| url != current);
        for (url, (format, size, mime_type, direct, indexed)) in found {
            let direct = direct && direct_count < 32;
            let indexed = indexed && indexed_count < 32;
            if !direct && !indexed {
                continue;
            }
            direct_count += usize::from(direct);
            indexed_count += usize::from(indexed);
            let id = self
                .choices
                .values()
                .find(|choice| choice.url == url)
                .map(|choice| choice.id)
                .unwrap_or_else(Uuid::new_v4);
            let request = self.response(&url).and_then(|fact| fact.3);
            self.choices.insert(
                id,
                Choice {
                    id,
                    url,
                    format,
                    size,
                    mime_type,
                    request,
                    direct,
                    indexed,
                },
            );
        }
        self.choices
            .retain(|_, choice| choice.direct || choice.indexed);
        let name = |choice: &Choice| {
            url::Url::parse(&choice.url)
                .ok()
                .map(|url| {
                    url.path()
                        .rsplit('/')
                        .next()
                        .unwrap_or("Video")
                        .chars()
                        .take(256)
                        .collect::<String>()
                })
                .unwrap_or_else(|| "Video".into())
        };
        let hostname = |choice: &Choice| {
            url::Url::parse(choice.source_url())
                .ok()
                .and_then(|url| url.host_str().map(str::to_owned))
                .unwrap_or_default()
        };
        json!({
            "choices": self.choices.values().filter(|choice| choice.direct && choice.format != Format::Dash).map(|c|json!({"id":c.id,"displayURL":c.url,"name":name(c),"format":c.format})).collect::<Vec<_>>(),
            "mpdCandidates":self.choices.values().filter(|c| c.format == Format::Dash).map(|c|json!({"id":c.id,"name":name(c),"hostname":hostname(c)})).collect::<Vec<_>>(),
            "indexedCandidates": self.choices.values().filter(|choice| choice.indexed).map(|c|json!({"id":c.id,"name":name(c),"hostname":hostname(c),"mimeType":c.mime_type,"totalSize":c.size})).collect::<Vec<_>>()
        })
    }
    pub fn choice(&self, id: Uuid, indexed: bool) -> Option<Choice> {
        self.choices
            .get(&id)
            .filter(|choice| {
                if indexed {
                    choice.indexed
                } else {
                    choice.direct
                }
            })
            .cloned()
    }
}

fn response_format(mime: &str) -> Option<Format> {
    if mime == "application/dash+xml" {
        return Some(Format::Dash);
    }
    if matches!(
        mime,
        "application/vnd.apple.mpegurl"
            | "application/x-mpegurl"
            | "audio/mpegurl"
            | "audio/x-mpegurl"
    ) {
        Some(Format::Hls)
    } else if mime.starts_with("video/")
        || mime.starts_with("audio/")
        || mime == "application/octet-stream"
    {
        // Generic binary responses are candidates; the metadata reader proves their media format.
        Some(Format::File)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_preserves_preloaded_candidates_in_the_same_view() {
        let mut media = Media::default();
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let first_url = "https://media.test/first.mpd";
        let second_url = "https://media.test/second.mpd";
        for (frame, url) in [(first, first_url), (second, second_url)] {
            media.observe_response(
                url.into(),
                (Format::Dash, None, "application/dash+xml".into(), None),
            );
            media.frame(frame, vec![], vec![url.into()]);
        }
        let before = media.sources(first, "blob:first");
        let old_id = Uuid::parse_str(before["mpdCandidates"][0]["id"].as_str().unwrap()).unwrap();
        let old_reader = media.retired.subscribe();

        media.clear_selection();

        assert!(*old_reader.borrow());
        assert!(!*media.retired.borrow());
        assert!(media.choice(old_id, false).is_none());
        let after = media.sources(second, "blob:second");
        let new_id = Uuid::parse_str(after["mpdCandidates"][0]["id"].as_str().unwrap()).unwrap();
        assert_eq!(media.choice(new_id, false).unwrap().url, second_url);
    }

    #[test]
    fn mpd_choices_are_observed_opaque_candidates_not_direct_urls() {
        let mut media = Media::default();
        let frame = Uuid::new_v4();
        let other = Uuid::new_v4();
        let url = "https://media.test/master.mpd?grant=private";
        media.observe_response(
            url.into(),
            (Format::Dash, None, "application/dash+xml".into(), None),
        );
        media.frame(frame, vec![], vec![url.into()]);
        media.frame(other, vec![], vec![]);
        let value = media.sources(frame, "blob:owned");
        assert_eq!(value["mpdCandidates"].as_array().unwrap().len(), 1);
        assert!(value["choices"].as_array().unwrap().is_empty());
        assert!(value["indexedCandidates"].as_array().unwrap().is_empty());
        assert!(!value.to_string().contains("grant="));
        assert!(!value.to_string().contains("https://"));
        let id = Uuid::parse_str(value["mpdCandidates"][0]["id"].as_str().unwrap()).unwrap();
        assert_eq!(media.choice(id, false).unwrap().format, Format::Dash);
        assert!(media.sources(other, "blob:other")["mpdCandidates"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn redirected_choice_uses_the_observed_final_request_context_privately() {
        let mut media = Media::default();
        let frame = Uuid::new_v4();
        let alias = "https://page.test/media";
        let final_url = "https://cdn.test/movie.mp4?grant=private";
        let request = std::sync::Arc::new(page::ObservedRequestContext {
            url: url::Url::parse(final_url).unwrap(),
            referer: Some("https://page.test/".parse().unwrap()),
            user_agent: Some("Owned browser".parse().unwrap()),
        });
        let direct = (Format::File, Some(500), "video/mp4".to_owned(), None);
        media.observe_response(alias.into(), direct.clone());
        media.frame(frame, vec![], vec![alias.into()]);
        media.observe_redirect(alias.into(), final_url.into());
        assert!(media.response(alias).is_none());
        media.observe_response(
            final_url.into(),
            (
                Format::File,
                Some(1000),
                "video/mp4".into(),
                Some(request.clone()),
            ),
        );

        let value = media.sources(frame, alias);
        let id = Uuid::parse_str(value["choices"][0]["id"].as_str().unwrap()).unwrap();
        let choice = media.choice(id, false).unwrap();
        assert_eq!(choice.source_url(), final_url);
        assert!(std::sync::Arc::ptr_eq(
            choice.request.as_ref().unwrap(),
            &request
        ));
        assert_eq!(value["choices"][0]["displayURL"], alias);
        assert_eq!(value["indexedCandidates"][0]["hostname"], "cdn.test");
        assert!(!value.to_string().contains("grant=private"));
        assert!(!value.to_string().contains("Owned browser"));
        assert_eq!(choice.size, Some(1000));
        media.observe_response(alias.into(), direct);
        let restored = media.sources(frame, alias);
        let id = Uuid::parse_str(restored["choices"][0]["id"].as_str().unwrap()).unwrap();
        let choice = media.choice(id, false).unwrap();
        assert_eq!(choice.size, Some(500));
        assert_eq!(choice.source_url(), alias);
        assert!(choice.request.is_none());
        assert!(!media.redirects.iter().any(|(old, _)| old == alias));
    }

    #[test]
    fn generic_binary_candidates_keep_exact_source_identity_and_private_urls() {
        let mut media = Media::default();
        let frame = Uuid::new_v4();
        let sibling = Uuid::new_v4();
        let first = "https://first.test/same.m4s?grant=first-private";
        let second = "https://second.test/same.m4s?grant=second-private";
        let unrelated = "https://other.test/same.m4s?grant=other-private";
        media.frame(frame, vec![], vec![first.into(), second.into()]);
        media.frame(sibling, vec![], vec![unrelated.into()]);
        media.sources(frame, "blob:owned");
        for (url, mime) in [
            (first, "video/mp4"),
            (second, "application/octet-stream"),
            (unrelated, "application/octet-stream"),
        ] {
            media.observe_response(
                url.into(),
                (
                    response_format(mime).unwrap(),
                    Some(28295780),
                    mime.into(),
                    None,
                ),
            );
        }
        let value = media.sources(frame, "blob:owned");
        assert!(value["choices"].as_array().unwrap().is_empty());
        let candidates = value["indexedCandidates"].as_array().unwrap();
        assert_eq!(candidates.len(), 2);
        let binary = candidates
            .iter()
            .find(|c| c["hostname"] == "second.test")
            .unwrap();
        assert_eq!(binary["mimeType"], "application/octet-stream");
        assert_eq!(candidates[0]["name"], candidates[1]["name"]);
        assert_ne!(candidates[0]["id"], candidates[1]["id"]);
        let id = Uuid::parse_str(binary["id"].as_str().unwrap()).unwrap();
        assert_eq!(media.choice(id, true).unwrap().source_url(), second);
        assert!(!value.to_string().contains("grant"));
        assert!(!value.to_string().contains("https://"));
        // A generic binary response still needs a known, positive, Browser-safe size.
        for size in [None, Some(0), Some(9_007_199_254_740_992)] {
            media.observe_response(
                second.into(),
                (Format::File, size, "application/octet-stream".into(), None),
            );
            assert_eq!(
                media.sources(frame, "blob:owned")["indexedCandidates"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
        }
        for mime in [
            "application/json",
            "text/html",
            "",
            "application/octet-streamish",
        ] {
            assert!(response_format(mime).is_none());
        }
        assert_eq!(
            response_format("application/vnd.apple.mpegurl"),
            Some(Format::Hls)
        );
    }

    #[test]
    fn indexed_sources_are_selected_frame_files_without_expanding_direct_choices() {
        let mut media = Media::default();
        let frame = Uuid::new_v4();
        let sibling = Uuid::new_v4();
        let video = "https://media.test/video.m4s?grant=private";
        let audio = "https://audio.test/audio.m4s?grant=private";
        let other = "https://media.test/sibling.m4s";
        for url in [video, audio, other] {
            media.observe_response(
                url.into(),
                (Format::File, Some(1000), "video/mp4".into(), None),
            );
        }
        media.frame(frame, vec![], vec![video.into(), audio.into()]);
        media.frame(sibling, vec![], vec![other.into()]);
        let value = media.sources(frame, "blob:owned");
        assert!(value["choices"].as_array().unwrap().is_empty());
        let indexed = value["indexedCandidates"].as_array().unwrap();
        assert_eq!(indexed.len(), 2);
        assert!(!serde_json::to_string(indexed).unwrap().contains("grant"));
        let id = Uuid::parse_str(indexed[0]["id"].as_str().unwrap()).unwrap();
        assert!(media.choice(id, true).is_some());
        assert!(media.choice(id, false).is_none());
        media.sources(sibling, "blob:other");
        assert!(media.choice(id, true).is_none());
        media.reset();
        assert!(media.choices.is_empty());
    }

    #[test]
    fn direct_file_keeps_its_choice_identity_when_also_indexed() {
        let mut media = Media::default();
        let frame = Uuid::new_v4();
        let url = "https://media.test/movie.mp4";
        media.observe_response(
            url.into(),
            (Format::File, Some(1000), "video/mp4".into(), None),
        );
        media.frame(frame, vec![], vec![url.into()]);
        let value = media.sources(frame, url);
        assert_eq!(
            value["choices"][0]["id"],
            value["indexedCandidates"][0]["id"]
        );
        assert_eq!(media.choices.len(), 1);
    }

    #[test]
    fn late_media_joins_either_event_order_after_static_resources() {
        for response_first in [true, false] {
            let mut media = Media::default();
            let frame = Uuid::new_v4();
            for batch in (0..140).collect::<Vec<_>>().chunks(128) {
                media.frame(
                    frame,
                    vec![],
                    batch
                        .iter()
                        .map(|i| format!("https://page.test/{i}.js"))
                        .collect(),
                );
            }
            let video = "https://media.test/later-video.m4s";
            let fact = (Format::File, Some(1000), "video/mp4".into(), None);
            if response_first {
                media.observe_response(video.into(), fact.clone());
            }
            media.frame(frame, vec![], vec![video.into()]);
            if !response_first {
                media.observe_response(video.into(), fact);
            }
            let value = media.sources(frame, "blob:owned");
            assert_eq!(value["indexedCandidates"].as_array().unwrap().len(), 1);
            let id =
                Uuid::parse_str(value["indexedCandidates"][0]["id"].as_str().unwrap()).unwrap();
            assert_eq!(media.choice(id, true).unwrap().url, video);
            assert!(media.frames[&frame].pending.len() <= 128);
        }
    }

    #[test]
    fn discovered_manifest_survives_later_segments_and_static_batches() {
        for (format, mime, choices) in [
            (Format::Hls, "application/vnd.apple.mpegurl", "choices"),
            (Format::Dash, "application/dash+xml", "mpdCandidates"),
        ] {
            let mut media = Media::default();
            let frame = Uuid::new_v4();
            let root = "https://page.test/manifest";
            let target = "https://cdn.test/manifest";
            media.frame(frame, vec![], vec![root.into()]);
            media.observe_response(target.into(), (format, None, mime.into(), None));
            // The redirect can be the final fact needed to join a frame with its response.
            media.observe_redirect(root.into(), target.into());
            let initial = media.sources(frame, "blob:owned")[choices][0]["id"].clone();
            assert!(initial.is_string());
            for i in 0..140 {
                let segment = format!("https://cdn.test/{i}.ts");
                media.observe_response(
                    segment.clone(),
                    (Format::File, Some(1000), "video/mp2t".into(), None),
                );
                media.frame(
                    frame,
                    vec![],
                    vec![segment, format!("https://page.test/{i}.js")],
                );
            }
            let value = media.sources(frame, "blob:owned");
            assert_eq!(value[choices][0]["id"], initial);
            assert_eq!(media.observed.len(), 128);
            assert!(media.frames[&frame].resources.len() <= 128);
            assert!(media.frames[&frame].pending.len() <= 128);
            assert!(media.frames[&frame]
                .resources
                .contains(&"https://cdn.test/139.ts".into()));
        }
    }

    #[test]
    fn removed_frame_retires_descendant_associations_without_touching_siblings() {
        let mut media = Media::default();
        let parent = Uuid::new_v4();
        let child = Uuid::new_v4();
        let sibling = Uuid::new_v4();
        let video = "https://media.test/video.mp4";
        for (frame, ancestors) in [(parent, vec![]), (child, vec![parent]), (sibling, vec![])] {
            media.frame(frame, ancestors, vec![video.into()]);
        }
        media.remove_frame(parent);
        // A response arriving after retirement cannot restore those associations.
        media.observe_response(
            video.into(),
            (Format::File, Some(1000), "video/mp4".into(), None),
        );
        assert!(media.sources(parent, "blob:owned")["indexedCandidates"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(media.sources(child, "blob:owned")["indexedCandidates"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(
            media.sources(sibling, "blob:owned")["indexedCandidates"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        media.reset();
        assert!(media.frames.is_empty() && media.observed.is_empty() && media.redirects.is_empty());
    }

    #[test]
    fn late_candidates_invalidate_the_queried_projection_in_either_arrival_order() {
        let mut media = Media::default();
        let frame = Uuid::new_v4();
        let early = "https://media.test/early.m4s";
        let video = "https://media.test/video.m4s";
        let audio = "https://media.test/audio.m4s";
        let fact = (Format::File, Some(1000), "video/mp4".into(), None);
        assert!(!media.frame(frame, vec![], vec![early.into()]));
        assert!(!media.observe_response(early.into(), fact.clone()));
        assert_eq!(
            media.sources(frame, "blob:owned")["indexedCandidates"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        assert!(!media.observe_response(video.into(), fact.clone()));
        assert!(media.frame(frame, vec![], vec![video.into()]));
        assert!(!media.frame(frame, vec![], vec![audio.into()]));
        assert!(media.observe_response(audio.into(), fact.clone()));
        let snapshot = media.sources(frame, "blob:owned");
        assert_eq!(snapshot["indexedCandidates"].as_array().unwrap().len(), 3);

        assert!(!media.frame(
            frame,
            vec![],
            vec![video.into(), "https://page.test/script.js".into()]
        ));
        let request = std::sync::Arc::new(page::ObservedRequestContext {
            url: url::Url::parse(video).unwrap(),
            referer: Some("https://page.test/".parse().unwrap()),
            user_agent: Some("Updated browser".parse().unwrap()),
        });
        // Private request context is refreshed without another public invalidation.
        assert!(!media.observe_response(
            video.into(),
            (fact.0, fact.1, fact.2.clone(), Some(request))
        ));
        assert_eq!(media.sources(frame, "blob:owned"), snapshot);
        assert!(media.observe_response(
            video.into(),
            (Format::File, Some(2000), "video/mp4".into(), None)
        ));
    }

    #[test]
    fn observation_follows_current_queries_and_retires_with_the_selected_frame() {
        let mut media = Media::default();
        let parent = Uuid::new_v4();
        let selected = Uuid::new_v4();
        let sibling = Uuid::new_v4();
        let first = "https://media.test/first.m4s";
        let alias = "https://page.test/master.m3u8";
        let target = "https://media.test/master.m3u8";
        let fact = (Format::File, Some(1000), "video/mp4".into(), None);
        media.frame(selected, vec![parent], vec![first.into()]);
        media.frame(sibling, vec![], vec![alias.into()]);
        media.sources(selected, "blob:first");
        media.sources(sibling, "blob:second");
        assert!(!media.observe_response(first.into(), fact.clone()));
        assert!(!media.observe_response(
            target.into(),
            (
                Format::Hls,
                None,
                "application/vnd.apple.mpegurl".into(),
                None
            )
        ));
        assert!(media.observe_redirect(alias.into(), target.into()));

        media.sources(selected, "blob:first");
        media.remove_frame(parent);
        assert!(media.observation.is_none() && media.choices.is_empty());
        assert!(!media.observe_response(first.into(), fact.clone()));
        media.sources(sibling, "blob:second");
        media.reset();
        assert!(media.observation.is_none());
        assert!(!media.observe_response(first.into(), fact));
    }
}
pub fn observe(
    view: &WebView,
    media: Rc<RefCell<Media>>,
    page_id: Uuid,
    events: page::Events,
) -> Result<()> {
    unsafe {
        view.webview()
            .cast::<ICoreWebView2_2>()?
            .add_WebResourceResponseReceived(
                &WebResourceResponseReceivedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut uri = PWSTR::null();
                    let request = args.Request()?;
                    request.Uri(&mut uri)?;
                    let uri = webview2_com::take_pwstr(uri);
                    if !page::valid_url(&uri) {
                        return Ok(());
                    }
                    let response = args.Response()?;
                    let mut status = 0;
                    response.StatusCode(&mut status)?;
                    let headers = response.Headers()?;
                    let header = |name: &str| -> Option<String> {
                        let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
                        let mut value = PWSTR::null();
                        headers.GetHeader(PCWSTR(name.as_ptr()), &mut value).ok()?;
                        Some(webview2_com::take_pwstr(value))
                    };
                    if matches!(status, 301 | 302 | 303 | 307 | 308) {
                        if let Some(target) = header("Location")
                            .and_then(|location| url::Url::parse(&uri).ok()?.join(&location).ok())
                            .filter(|url| page::valid_url(url.as_str()))
                        {
                            let mut media = media.borrow_mut();
                            if media.observe_redirect(uri, target.to_string()) {
                                events.send(json!({"type":"page_media_changed","pageId":page_id}));
                            }
                        }
                        return Ok(());
                    }
                    if !(200..300).contains(&status) {
                        return Ok(());
                    }
                    let mime = header("Content-Type")
                        .unwrap_or_default()
                        .split(';')
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_ascii_lowercase();
                    if mime.len() > 256 {
                        return Ok(());
                    }
                    let Some(format) = response_format(&mime) else {
                        return Ok(());
                    };
                    let size = if status == 206 {
                        header("Content-Range")
                            .and_then(|v| v.rsplit('/').next()?.parse::<u64>().ok())
                    } else {
                        header("Content-Length").and_then(|v| v.parse().ok())
                    };
                    let request_context =
                        (|| -> Option<std::sync::Arc<page::ObservedRequestContext>> {
                            let headers = request.Headers().ok()?;
                            let read = |name: &str| -> Option<reqwest::header::HeaderValue> {
                                let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
                                let mut value = PWSTR::null();
                                headers.GetHeader(PCWSTR(name.as_ptr()), &mut value).ok()?;
                                let value = webview2_com::take_pwstr(value);
                                if value.is_empty() || value.len() > 4096 {
                                    return None;
                                }
                                value.parse().ok()
                            };
                            Some(std::sync::Arc::new(page::ObservedRequestContext {
                                url: url::Url::parse(&uri).ok()?,
                                referer: read("Referer"),
                                user_agent: read("User-Agent"),
                            }))
                        })();
                    let mut media = media.borrow_mut();
                    if media.observe_response(uri, (format, size, mime, request_context)) {
                        events.send(json!({"type":"page_media_changed","pageId":page_id}));
                    }
                    Ok(())
                })),
                &mut Default::default(),
            )?;
    }
    Ok(())
}
pub fn cookies(
    view: &WebView,
    url: String,
    retired: watch::Receiver<bool>,
    reply: oneshot::Sender<Result<Option<String>, String>>,
) -> Result<()> {
    let uri: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
    unsafe {
        view.webview()
            .cast::<ICoreWebView2_2>()?
            .CookieManager()?
            .GetCookies(
                PCWSTR(uri.as_ptr()),
                &GetCookiesCompletedHandler::create(Box::new(move |status, list| {
                    let result = (|| -> Result<Option<String>> {
                        status?;
                        if *retired.borrow() {
                            return Err(anyhow!("watch_source_retired"));
                        }
                        let mut pairs = vec![];
                        if let Some(list) = list {
                            let mut count = 0;
                            list.Count(&mut count)?;
                            if count > 128 {
                                return Err(anyhow!("watch_media_credentials_unavailable"));
                            }
                            for i in 0..count {
                                let cookie = list.GetValueAtIndex(i)?;
                                let mut name = PWSTR::null();
                                let mut value = PWSTR::null();
                                cookie.Name(&mut name)?;
                                cookie.Value(&mut value)?;
                                pairs.push(format!(
                                    "{}={}",
                                    webview2_com::take_pwstr(name),
                                    webview2_com::take_pwstr(value)
                                ));
                            }
                        }
                        let value = pairs.join("; ");
                        if value.len() > 16384 {
                            return Err(anyhow!("watch_media_credentials_unavailable"));
                        }
                        Ok((!value.is_empty()).then_some(value))
                    })();
                    let _ = reply.send(result.map_err(|e| e.to_string()));
                    Ok(())
                })),
            )?;
    }
    Ok(())
}
