use anyhow::{anyhow, ensure, Result};
use rquickjs::{Context, Function, Runtime};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, sync::Arc};
use url::Url;
use uuid::Uuid;

pub type Cancelled = Arc<dyn Fn() -> bool + Send + Sync>;
#[derive(Clone, Copy)]
pub struct Limits {
    pub manifest_bytes: usize,
    pub resources: usize,
    // Engine engineering budgets; not MPD syntax or a wire contract.
    pub heap_bytes: usize,
    pub stack_bytes: usize,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceInfo {
    #[serde(skip_serializing)]
    indices: Vec<usize>,
    pub label: String,
    pub kind: String,
    pub role: String,
    pub mime_type: String,
    pub language: String,
    pub codec: String,
    pub frame_rate: Option<f64>,
    pub width: Option<u64>,
    pub height: Option<u64>,
    pub bandwidth: Option<u64>,
}
#[derive(Clone, Serialize)]
pub struct Choice {
    pub id: Uuid,
    pub info: ChoiceInfo,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct ByteRange {
    pub offset: u64,
    pub length: u64,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct ResourceRecipe {
    pub url: String,
    pub range: Option<ByteRange>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentRecipe {
    pub resource: ResourceRecipe,
    pub initialization: Option<ResourceRecipe>,
    pub duration: f64,
    pub presentation_time: Option<f64>,
    pub timeline: f64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTrack {
    pub index: usize,
    pub mime_type: String,
    pub period: f64,
    pub codecs: String,
    pub index_resource: Option<ResourceRecipe>,
    pub index_init: Option<ResourceRecipe>,
    pub segments: Vec<SegmentRecipe>,
}
impl ResolvedTrack {
    pub fn resources(&self) -> impl Iterator<Item = &ResourceRecipe> {
        self.index_resource
            .iter()
            .chain(self.index_init.iter())
            .chain(
                self.segments
                    .iter()
                    .flat_map(|s| std::iter::once(&s.resource).chain(s.initialization.iter())),
            )
    }
}
pub struct MpdSnapshot {
    pub source_id: Uuid,
    xml: String,
    base: Url,
    choices: Vec<Choice>,
    limits: Limits,
    cancelled: Cancelled,
}
impl MpdSnapshot {
    pub fn inspect(
        source_id: Uuid,
        xml: String,
        base: Url,
        limits: Limits,
        cancelled: Cancelled,
    ) -> Result<Self> {
        ensure!(xml.len() <= limits.manifest_bytes, "watch_manifest_limit");
        let result = invoke(
            "inspectMpd",
            &xml,
            base.as_str(),
            None,
            None,
            limits,
            cancelled.clone(),
        )?;
        let infos: Vec<ChoiceInfo> =
            serde_json::from_str(&result).map_err(|_| anyhow!("watch_mpd_invalid"))?;
        ensure!(!infos.is_empty(), "watch_mpd_unsupported");
        ensure!(infos.len() <= limits.resources, "watch_resource_limit");
        let choices = infos
            .into_iter()
            .map(|info| Choice {
                id: Uuid::new_v4(),
                info,
            })
            .collect();
        Ok(Self {
            source_id,
            xml,
            base,
            choices,
            limits,
            cancelled,
        })
    }
    pub fn choices(&self) -> &[Choice] {
        &self.choices
    }
    pub fn serialize_selected(
        &self,
        ids: &[Uuid],
        bindings: &std::collections::BTreeMap<String, Uuid>,
    ) -> Result<String> {
        let indices: Vec<usize> = ids
            .iter()
            .map(|id| {
                self.choices
                    .iter()
                    .find(|c| c.id == *id)
                    .map(|c| c.info.indices.clone())
                    .ok_or_else(|| anyhow!("watch_source_changed"))
            })
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect();
        let output = invoke(
            "serializeMpd",
            &self.xml,
            self.base.as_str(),
            Some(&serde_json::to_string(&indices)?),
            Some(&serde_json::to_string(bindings)?),
            self.limits,
            self.cancelled.clone(),
        )?;
        ensure!(
            output.len() <= self.limits.manifest_bytes,
            "watch_manifest_limit"
        );
        Ok(output)
    }
    pub fn resolve_selected(&self, ids: &[Uuid]) -> Result<Vec<ResolvedTrack>> {
        ensure!(!(self.cancelled)(), "watch_source_retired");
        ensure!(
            !ids.is_empty() && ids.len() <= self.choices.len(),
            "watch_source_changed"
        );
        let mut unique = BTreeSet::new();
        let selected_groups: Vec<Vec<usize>> = ids
            .iter()
            .map(|id| {
                ensure!(unique.insert(*id), "watch_source_changed");
                self.choices
                    .iter()
                    .find(|c| c.id == *id)
                    .map(|c| c.info.indices.clone())
                    .ok_or_else(|| anyhow!("watch_source_changed"))
            })
            .collect::<Result<_>>()?;
        let indices: Vec<usize> = selected_groups.into_iter().flatten().collect();
        let selected = serde_json::to_string(&indices)?;
        let result = invoke(
            "resolveMpd",
            &self.xml,
            self.base.as_str(),
            Some(&selected),
            None,
            self.limits,
            self.cancelled.clone(),
        )?;
        let tracks: Vec<ResolvedTrack> =
            serde_json::from_str(&result).map_err(|_| anyhow!("watch_mpd_invalid"))?;
        ensure!(tracks.len() == indices.len(), "watch_mpd_invalid");
        let mut urls = BTreeSet::new();
        for track in &tracks {
            ensure!(
                indices.contains(&track.index) && track.period.is_finite(),
                "watch_mpd_invalid"
            );
            for segment in &track.segments {
                ensure!(
                    segment.duration.is_finite()
                        && segment.duration > 0.0
                        && segment.timeline.is_finite()
                        && segment.presentation_time.is_none_or(f64::is_finite),
                    "watch_mpd_invalid"
                );
            }
            for resource in track.resources() {
                let url = Url::parse(&resource.url).map_err(|_| anyhow!("watch_mpd_invalid"))?;
                ensure!(
                    matches!(url.scheme(), "http" | "https")
                        && url.username().is_empty()
                        && url.password().is_none()
                        && url.fragment().is_none(),
                    "watch_resource_unavailable"
                );
                if let Some(range) = &resource.range {
                    ensure!(
                        range.length > 0 && range.offset.checked_add(range.length).is_some(),
                        "invalid_watch_range"
                    );
                }
                urls.insert(resource.url.as_str());
                ensure!(urls.len() <= self.limits.resources, "watch_resource_limit");
            }
        }
        ensure!(!(self.cancelled)(), "watch_source_retired");
        Ok(tracks)
    }
}
fn invoke(
    name: &str,
    xml: &str,
    base: &str,
    selected: Option<&str>,
    bindings: Option<&str>,
    limits: Limits,
    cancelled: Cancelled,
) -> Result<String> {
    ensure!(!cancelled(), "watch_source_retired");
    let runtime = Runtime::new().map_err(|_| anyhow!("watch_mpd_engine_unavailable"))?;
    runtime.set_memory_limit(limits.heap_bytes);
    runtime.set_max_stack_size(limits.stack_bytes);
    let stop = cancelled.clone();
    runtime.set_interrupt_handler(Some(Box::new(move || stop())));
    let context = Context::full(&runtime).map_err(|_| anyhow!("watch_mpd_engine_unavailable"))?;
    #[cfg(test)]
    let weak = runtime.weak();
    let mut failure = "watch_mpd_invalid";
    let result = context.with(|ctx| -> rquickjs::Result<String> {
        let join = Function::new(ctx.clone(), |value: String, base: String| -> String {
            let base = Url::parse(&base).ok();
            match Url::options().base_url(base.as_ref()).parse(&value) {
                Ok(url) => serde_json::json!({"href":url.as_str(),"protocol":format!("{}:",url.scheme())}).to_string(),
                Err(_) => "null".into(),
            }
        })?;
        ctx.globals().set("__joinURL", join)?;
        ctx.eval::<(), _>(r#"
            globalThis.window = globalThis;
            globalThis.URL = class {
                constructor(value, base) {
                    const url = JSON.parse(__joinURL(
                        String(value), base ? String(base) : ''
                    ));
                    if (!url) throw Error('invalid_url');
                    Object.assign(this, url);
                }
                toString() {
                    return this.href;
                }
            };
        "#)?;
        ctx.eval::<(), _>(include_str!("resolver.js"))?;
        let function: Function = ctx.globals().get(name)?;
        let called = match (selected, bindings) {
            (Some(selected), Some(bindings)) => function.call((xml, base, selected, bindings)),
            (Some(selected), None) => function.call((xml, base, selected)),
            _ => function.call((xml, base)),
        };
        if called.is_err() {
            let exception = ctx.catch();
            let message = exception
                .as_object()
                .and_then(|object| object.get::<_, String>("message").ok());
            if matches!(message.as_deref(), Some("unsupported_mpd" | "external_mpd")) {
                failure = "watch_mpd_unsupported";
            }
        }
        called
    });
    drop(context);
    drop(runtime);
    #[cfg(test)]
    assert!(
        weak.try_ref().is_none(),
        "operation retained its JS runtime"
    );
    if cancelled() {
        return Err(anyhow!("watch_source_retired"));
    }
    // JS exceptions may contain source URLs. Only this fixed code crosses the source boundary.
    result.map_err(|_| anyhow!(failure))
}
#[cfg(test)]
mod tests;
