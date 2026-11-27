#[path = "page_media.rs"]
mod media;
// UI-thread ownership for website windows. Only the App connection supplies commands.
use super::{caption, Language, ServiceEvent, Theme, WindowAction, WindowControls};
use crate::app::page::{self, Command, MediaState, Operation};
use anyhow::{anyhow, bail, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::{BTreeMap, VecDeque},
    rc::Rc,
};
use tao::{
    dpi::LogicalSize,
    event_loop::{EventLoopProxy, EventLoopWindowTarget},
    platform::windows::{WindowBuilderExtWindows, WindowExtWindows},
    window::{Window, WindowId},
};
use tokio::sync::oneshot;
use uuid::Uuid;
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Deferral, ICoreWebView2Environment, ICoreWebView2NewWindowRequestedEventArgs,
        ICoreWebView2PermissionRequestedEventArgs3, ICoreWebView2_2,
        COREWEBVIEW2_PERMISSION_STATE_DENY, COREWEBVIEW2_PROCESS_FAILED_KIND,
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    },
    NewWindowRequestedEventHandler, PermissionRequestedEventHandler, ProcessFailedEventHandler,
    WindowCloseRequestedEventHandler,
};
use windows_core::{Interface, PWSTR};
use wry::{WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};

type Views = Rc<RefCell<BTreeMap<Uuid, PageView>>>;
type Reply = oneshot::Sender<Result<Value, String>>;
const MAX_PAGE_VIEWS: usize = 64;
const MAX_PENDING_POPUPS: usize = 64;
const MAX_PAGE_CANDIDATES: usize = 64;
const MAX_CANDIDATE_RESOURCE_BYTES: usize = 4096;
#[derive(Deserialize)]
struct Message {
    document: Uuid,
    frame: Uuid,
    #[serde(default)]
    ancestors: Vec<Uuid>,
    #[serde(flatten)]
    event: PageEvent,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum PageEvent {
    Document,
    Resources {
        urls: Vec<String>,
    },
    Removed {
        removed: Uuid,
    },
    Candidates {
        candidates: Vec<ReportedCandidate>,
        removed: Vec<Uuid>,
    },
    Sample {
        media: Uuid,
        resource: String,
        revision: u64,
        event: MediaEvent,
    },
    Reply {
        request: Uuid,
        state: Option<MediaState>,
        error: Option<String>,
    },
    Blocked {
        media: Uuid,
    },
}
#[derive(Clone, Deserialize)]
struct ReportedCandidate {
    media: Uuid,
    resource: String,
    revision: u64,
    title: String,
    url: Option<String>,
    duration: Option<f64>,
}
#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum MediaEvent {
    Emptied,
    Loadedmetadata,
    Loadeddata,
    Play,
    Playing,
    Pause,
    Seeked,
    Ratechange,
    Ended,
    Waiting,
    Error,
}
struct Candidate {
    view: Uuid,
    frame: Uuid,
    ancestors: Vec<Uuid>,
    source: ReportedCandidate,
}
struct Pending {
    view: Uuid,
    candidate_id: Uuid,
    reply: Reply,
    frame: Uuid,
    selecting: bool,
    promote: Option<(Uuid, tokio::sync::watch::Receiver<bool>)>,
    patch: bool,
}
impl Pending {
    fn retire_missing_candidates(
        requests: &mut BTreeMap<Uuid, Self>,
        candidates: &BTreeMap<Uuid, Candidate>,
    ) {
        for (_, pending) in requests.extract_if(.., |_, p| !candidates.contains_key(&p.candidate_id)) {
            let _ = pending.reply.send(Err("page_candidate_unavailable".into()));
        }
    }

    fn take_reply(requests: &mut BTreeMap<Uuid, Self>, request: Uuid, view: Uuid, frame: Uuid) -> Option<Self> {
        let pending = requests.get(&request)?;
        if pending.view != view || pending.frame != frame { return None; }
        requests.remove(&request).filter(|pending| !pending.reply.is_closed())
    }
}
struct Popup {
    args: ICoreWebView2NewWindowRequestedEventArgs,
    environment: ICoreWebView2Environment,
    deferral: ICoreWebView2Deferral,
}
impl Drop for Popup {
    fn drop(&mut self) {
        unsafe {
            let _ = self.deferral.Complete();
        }
    }
}
struct PageView {
    process_failed_token: i64,
    popups: Rc<RefCell<VecDeque<Popup>>>,
    // Both WebViews drop before their native window.
    caption: caption::Caption,
    view: WebView,
    window: Window,
    document: Option<Uuid>,
    mounted: Option<(isize, wry::Rect)>,
    media: Rc<RefCell<media::Media>>,
}
impl PageView {
    fn mount(&mut self, parent: isize, bounds: wry::Rect) -> Result<()> {
        if let Some((current, _)) = self.mounted {
            if current != parent {
                self.release_mount()?;
            }
        }
        if self.mounted.is_none() {
            let scale = self.window.scale_factor();
            let previous = self.view.bounds()?;
            let standalone_bounds = wry::Rect {
                position: previous.position.to_logical::<f64>(scale).into(),
                size: previous.size.to_logical::<f64>(scale).into(),
            };
            // Reparent the live player without sending the website a visibility transition.
            self.view.reparent(parent)?;
            self.mounted = Some((parent, standalone_bounds));
            self.window.set_visible(false);
        }
        if let Err(error) = self.view.set_bounds(bounds) {
            let _ = self.release_mount();
            return Err(error.into());
        }
        Ok(())
    }

    fn release_mount(&mut self) -> Result<()> {
        if let Some((_, bounds)) = self.mounted {
            self.view.reparent(self.window.hwnd())?;
            self.mounted = None;
            self.view.set_bounds(bounds)?;
        }
        Ok(())
    }
}

impl Drop for PageView {
    fn drop(&mut self) {
        unsafe {
            let _ = self.view.webview().remove_ProcessFailed(self.process_failed_token);
        }
        let pending = std::mem::take(&mut *self.popups.borrow_mut());
        drop(pending);
        self.media.borrow().retired.send_replace(true);
    }
}
struct Page {
    root: Uuid,
    requested_url: String,
    views: Views,
    owner: Uuid,
    origin: String,
    id: Uuid,
    events: page::Events,
    candidates: BTreeMap<Uuid, Candidate>,
    selected: Option<Uuid>,
    original_page: bool,
    picker_document: Option<u64>,
    pending: BTreeMap<Uuid, Pending>,
}
impl Page {
    fn selected_view(&self) -> Uuid {
        self.selected
            .and_then(|id| self.candidates.get(&id))
            .map_or(self.root, |c| c.view)
    }
    fn emit(&self, value: Value) {
        self.events.send(value);
    }
    fn record_retirement(&self, reason: &'static str) {
        piik_channel_native::diagnostics::app_retired(self.owner, Some(self.id), reason);
    }
    fn release_selection(&mut self, view_key: Uuid) -> bool {
        if !self.original_page { return false; }
        let Some(candidate_id) = self.selected else { return true };
        let mut views = self.views.borrow_mut();
        let view = views.get_mut(&view_key).unwrap();
        let mounted = view.mounted.is_some();
        if view.release_mount().is_err() { return false; }
        view.media.borrow_mut().clear_selection();
        if mounted { view.window.set_visible(true); }
        self.root = view_key;
        self.selected = None;
        self.emit(json!({"type":"page_selection_lost","pageId":self.id,"candidateId":candidate_id}));
        true
    }
    fn candidates(&mut self) {
        Pending::retire_missing_candidates(&mut self.pending, &self.candidates);
        let views = self.views.borrow();
        let page_urls = views.iter().filter_map(|(id, view)| view.view.url().ok()
            .filter(|url| page::valid_url(url)).map(|url| (*id, url))).collect::<BTreeMap<_, _>>();
        for (key, view) in views.iter() {
            let enabled = self.picker_document.is_some() && self.candidates.values().any(|candidate| candidate.view == *key);
            view.caption.share_picker(enabled);
        }
        self.emit(candidate_catalog(self.id, self.selected_view(), &self.requested_url, &self.candidates, &page_urls));
    }
    fn request(&mut self, candidate_id: Option<Uuid>, selecting: bool, patch: Option<page::Patch>, reply: Reply) {
        self.pending.retain(|_, pending| !pending.reply.is_closed());
        let Some((id, candidate)) = candidate_id.or(self.selected)
            .and_then(|id| self.candidates.get(&id).map(|candidate| (id, candidate))) else {
            let _ = reply.send(Err("page_candidate_unavailable".into()));
            return;
        };
        if self.pending.len() >= 64 {
            let _ = reply.send(Err("page_player_busy".into()));
            return;
        }
        let promote = if let Some(id) = candidate_id.filter(|_| selecting) {
            let Some(lifetime) = self.views.borrow()[&candidate.view].media.borrow().candidate_lifetime(id) else {
                let _ = reply.send(Err("watch_source_retired".into()));
                return;
            };
            Some((id, lifetime))
        } else {
            None
        };
        let request = Uuid::new_v4();
        let command = json!({"bridge":"piik-page-command","kind":if patch.is_some(){"patch"}else{"read"},
            "originalPage":self.original_page,"frame":candidate.frame,"media":candidate.source.media,"revision":candidate.source.revision,"request":request,"patch":patch});
        match self
            .views
            .borrow()
            .get(&candidate.view)
            .unwrap()
            .view
            .evaluate_script(&format!("window.postMessage({command}, '*')"))
        {
            Ok(()) => {
                self.pending.insert(
                    request,
                    Pending {
                        view: candidate.view,
                        candidate_id: id,
                        reply,
                        frame: candidate.frame,
                        selecting,
                        promote,
                        patch: patch.is_some(),
                    },
                );
            }
            Err(_) => {
                let _ = reply.send(Err("page_player_closed".into()));
            }
        }
    }
}
impl Drop for Page {
    fn drop(&mut self) {
        let views = std::mem::take(&mut *self.views.borrow_mut());
        drop(views);
        for (_, pending) in std::mem::take(&mut self.pending) {
            let _ = pending.reply.send(Err("page_player_closed".into()));
        }
        self.emit(json!({"type":"page_closed","pageId":self.id}));
    }
}
pub(super) struct Pages {
    context: WebContext,
    pages: BTreeMap<Uuid, Page>,
}
impl Pages {
    pub fn new(path: std::path::PathBuf) -> Self {
        Self {
            context: WebContext::new(Some(path)),
            pages: BTreeMap::new(),
        }
    }
    pub fn clear(&mut self) {
        for page in self.pages.values() {
            page.record_retirement("app_shutdown");
        }
        self.pages.clear();
    }
    fn retire_page(&mut self, key: Uuid, reason: &'static str) {
        if let Some(page) = self.pages.remove(&key) {
            page.record_retirement(reason);
        }
    }
    pub fn mount(
        &mut self,
        page_id: Uuid,
        origin: &str,
        main: &Window,
        bounds: Option<wry::Rect>,
    ) -> bool {
        let Some(page) = self
            .pages
            .values()
            .find(|page| page.id == page_id && page.origin == origin)
        else {
            return false;
        };
        let Some(candidate) = page.selected.and_then(|id| page.candidates.get(&id)) else {
            return false;
        };
        let view_id = candidate.view;
        let views = page.views.clone();
        if bounds.is_some() {
            for page in self.pages.values() {
                for (id, view) in page.views.borrow_mut().iter_mut() {
                    if *id != view_id && view.release_mount().is_err() {
                        return false;
                    }
                }
            }
        }
        let mut views = views.borrow_mut();
        let Some(view) = views
            .get_mut(&view_id)
            .filter(|view| view.document.is_some())
        else {
            return false;
        };
        match bounds {
            Some(bounds) => view.mount(main.hwnd(), bounds).is_ok(),
            None => view.release_mount().is_ok(),
        }
    }

    pub fn share_picker(&mut self, id: Uuid, site: &str, document: Option<u64>) {
        if let Some(page) = self.pages.values_mut().find(|page| page.id == id && page.origin == site) {
            page.picker_document = document;
            page.candidates();
        }
    }

    pub fn request_share_picker(&self, id: WindowId, site: &str, document: u64) -> bool {
        self.pages.values().any(|page| {
            if page.origin != site || page.picker_document != Some(document) { return false; }
            page.views.borrow().iter().any(|(key, view)| {
                if view.window.id() != id || !page.candidates.values().any(|candidate| candidate.view == *key) {
                    return false;
                }
                page.emit(json!({"type":"page_share_requested","pageId":page.id}));
                true
            })
        })
    }

    pub fn release_mounts(&mut self) {
        for page in self.pages.values_mut() {
            page.picker_document = None;
            for view in page.views.borrow_mut().values_mut() {
                view.caption.share_picker(false);
                let _ = view.release_mount();
            }
        }
    }

    pub fn appearance(&self, theme: &Theme, language: Language) {
        for page in self.pages.values() {
            for view in page.views.borrow().values() {
                view.caption.appearance(theme, language, None);
            }
        }
    }
    pub fn window_action(&self, id: WindowId, action: &WindowAction) {
        for page in self.pages.values() {
            if let Some(view) = page
                .views
                .borrow()
                .values()
                .find(|view| view.window.id() == id)
            {
                caption::apply(&view.window, action);
                return;
            }
        }
    }
    pub fn caption_ready(
        &self,
        id: WindowId,
        theme: &Theme,
        language: Language,
        controls: &WindowControls,
    ) {
        for page in self.pages.values() {
            if let Some(view) = page
                .views
                .borrow()
                .values()
                .find(|view| view.window.id() == id)
            {
                view.caption.ready(theme, language);
                if view.mounted.is_none() {
                    view.caption.layout(&view.window, &view.view, controls);
                }
                return;
            }
        }
    }
    pub fn resize(&self, id: WindowId, controls: &WindowControls) {
        for page in self.pages.values() {
            if let Some(view) = page
                .views
                .borrow()
                .values()
                .find(|view| view.window.id() == id)
            {
                if view.mounted.is_none() {
                    view.caption.layout(&view.window, &view.view, controls);
                }
                return;
            }
        }
    }
    pub fn close_window(&mut self, id: WindowId) -> bool {
        let found = self.pages.iter().find_map(|(key, page)| {
            page.views
                .borrow()
                .iter()
                .find_map(|(view, value)| (value.window.id() == id).then_some((*key, *view)))
        });
        let Some((key, view)) = found else {
            return false;
        };
        self.remove_view(key, view, "window_closed");
        true
    }
    pub fn process_exited(&mut self, view: Uuid) {
        let key = self.pages.iter()
            .find_map(|(key, page)| page.views.borrow().contains_key(&view).then_some(*key));
        if let Some(key) = key {
            self.remove_view(key, view, "webview_process_exited");
        }
    }
    fn remove_view(&mut self, key: Uuid, view: Uuid, reason: &'static str) {
        let page = self.pages.get_mut(&key).unwrap();
        if page.views.borrow().len() == 1
            || (page.selected.is_some() && page.selected_view() == view)
        {
            self.retire_page(key, reason);
        } else {
            page.candidates
                .retain(|_, candidate| candidate.view != view);
            let removed = page.views.borrow_mut().remove(&view);
            drop(removed);
            if view == page.root {
                page.root = *page.views.borrow().keys().next().unwrap();
            }
            page.candidates();
        }
    }
    pub fn navigate(&mut self, view: Uuid) {
        let Some(key) = self
            .pages
            .iter()
            .find_map(|(key, page)| page.views.borrow().contains_key(&view).then_some(*key))
        else {
            return;
        };
        let page = self.pages.get_mut(&key).unwrap();
        if page.selected.is_some() && page.selected_view() == view && !page.release_selection(view) {
            self.retire_page(key, "selected_view_navigated");
        } else {
            let mut views = page.views.borrow_mut();
            let current = views.get_mut(&view).unwrap();
            current.media.borrow_mut().reset();
            current.document = None;
            page.candidates
                .retain(|_, candidate| candidate.view != view);
            drop(views);
            page.candidates();
        }
    }
    pub fn popup(
        &mut self,
        opener: Uuid,
        target: &EventLoopWindowTarget<ServiceEvent>,
        events: EventLoopProxy<ServiceEvent>,
    ) {
        let Some(page) = self
            .pages
            .values()
            .find(|page| page.views.borrow().contains_key(&opener))
        else {
            return;
        };
        let Some(popup) = page.views.borrow()[&opener].popups.borrow_mut().pop_front() else {
            return;
        };
        let create = || -> Result<()> {
            anyhow::ensure!(
                page.views.borrow().len() < MAX_PAGE_VIEWS,
                "page_player_limit"
            );
            let key = Uuid::new_v4();
            let child = page_view(
                WebViewBuilder::new().with_environment(popup.environment.clone()),
                key,
                events,
                target,
            )?;
            // SetNewWindow replaces the underlying web contents. Observe that final content
            // before completing the deferral and allowing its first navigation.
            unsafe {
                popup.args.SetNewWindow(&child.view.webview())?;
            }
            media::observe(
                &child.view,
                child.media.clone(),
                page.id,
                page.events.clone(),
            )?;
            page.views.borrow_mut().insert(key, child);
            Ok(())
        };
        // A failed child remains local and drops; Popup always completes its deferral.
        let _ = create();
    }
    pub fn command(
        &mut self,
        command: Command,
        target: &EventLoopWindowTarget<ServiceEvent>,
        events: EventLoopProxy<ServiceEvent>,
    ) {
        match command {
            Command::Media {
                candidate_id,
                owner,
                page_id,
                choice_id,
                indexed,
                reply,
            } => {
                let result = (|| -> Result<(page::MediaContext, page::IndexedFile)> {
                    let page = self
                        .pages
                        .values()
                        .find(|p| p.owner == owner && p.id == page_id)
                        .ok_or_else(|| anyhow!("page_player_closed"))?;
                    let selected = candidate_id.or(page.selected)
                        .and_then(|id| page.candidates.get(&id))
                        .ok_or_else(|| anyhow!("page_candidate_unavailable"))?;
                    let views = page.views.borrow();
                    let view = views
                        .get(&selected.view)
                        .ok_or_else(|| anyhow!("page_player_closed"))?;
                    let (choice, retired) = {
                        let mut media = view.media.borrow_mut();
                        if let Some(id) = candidate_id {
                            media.candidate_choice(id, choice_id, indexed)
                        } else {
                            media.sources(selected.frame, &selected.source.resource);
                            media.choice(choice_id, indexed).map(|choice| (choice, media.retired.subscribe()))
                        }
                    }.ok_or_else(|| anyhow!("watch_resource_unavailable"))?;
                    let document = view.document.ok_or_else(|| anyhow!("page_player_closed"))?;
                    let events = events.clone();
                    let cookies: page::Cookies = std::sync::Arc::new(move |url| {
                        let events = events.clone();
                        Box::pin(async move {
                            let (reply, result) = oneshot::channel();
                            events
                                .send_event(ServiceEvent::PageCommand(std::sync::Arc::new(
                                    std::sync::Mutex::new(Some(Command::Cookies {
                                        owner,
                                        page_id,
                                        document,
                                        url,
                                        reply,
                                    })),
                                )))
                                .map_err(|_| anyhow!("page_player_closed"))?;
                            result.await?.map_err(anyhow::Error::msg)
                        })
                    });
                    Ok((page::MediaContext {
                        url: choice.source_url().to_owned(),
                        request: choice.request,
                        format: choice.format,
                        size: choice.size,
                        retired,
                        cookies,
                    }, choice.file.unwrap_or_default()))
                })();
                let _ = reply.send(result.map_err(|e| e.to_string()));
                return;
            }
            Command::Cookies {
                owner,
                page_id,
                document,
                url,
                reply,
            } => {
                let page = self
                    .pages
                    .values()
                    .find(|p| p.owner == owner && p.id == page_id);
                let views = page.map(|page| page.views.borrow());
                if let Some(view) = views
                    .as_ref()
                    .and_then(|views| views.values().find(|view| view.document == Some(document)))
                {
                    if page::valid_url(&url) {
                        let _ = media::cookies(
                            &view.view,
                            url,
                            view.media.borrow().retired.subscribe(),
                            reply,
                        );
                    } else {
                        let _ = reply.send(Err("invalid_watch_url".into()));
                    }
                } else {
                    let _ = reply.send(Err("page_player_closed".into()));
                }
                return;
            }
            command => {
                self.operation(command, target, events);
                return;
            }
        }
    }
    fn operation(
        &mut self,
        command: Command,
        target: &EventLoopWindowTarget<ServiceEvent>,
        events: EventLoopProxy<ServiceEvent>,
    ) {
        let Command::Request {
            owner,
            operation,
            events: outgoing,
            reply,
        } = command
        else {
            if let Command::Retire { owner } = command {
                self.pages.retain(|_, page| {
                    if page.owner != owner {
                        return true;
                    }
                    page.record_retirement("control_retired");
                    false
                });
            }
            return;
        };
        if reply.is_closed() && !matches!(operation, Operation::PageClose { .. }) {
            return;
        }
        if let Operation::PagePrepare { page_id, url } = operation {
            match self.prepare(owner, page_id, url, outgoing, target, events) {
                Ok(page) => self.publish(page, reply),
                Err(error) => {
                    let _ = reply.send(Err(error.to_string()));
                }
            }
            return;
        }
        let id = match &operation {
            Operation::PageSelect { page_id, .. }
            | Operation::PageRead { page_id, .. }
            | Operation::PagePatch { page_id, .. }
            | Operation::PageFocus { page_id }
            | Operation::PageHide { page_id }
            | Operation::PageClose { page_id }
            | Operation::PageMediaSources { page_id, .. } | Operation::PageMediaStop { page_id, .. } => *page_id,
            _ => unreachable!(),
        };
        let key = self
            .pages
            .iter()
            .find(|(_, page)| page.owner == owner && page.id == id)
            .map(|(key, _)| *key);
        if matches!(operation, Operation::PageClose { .. }) {
            if let Some(key) = key {
                self.retire_page(key, "page_close_requested");
            }
            let _ = reply.send(Ok(Value::Null));
            return;
        }
        let Some(page) = key.and_then(|key| self.pages.get_mut(&key)) else {
            let _ = reply.send(Err("page_player_closed".into()));
            return;
        };
        match operation {
            Operation::PageMediaStop { candidate_id: Some(id), .. } => {
                for view in page.views.borrow().values() { view.media.borrow_mut().cancel_candidate(id); }
                let _ = reply.send(Ok(Value::Null));
            }
            Operation::PageMediaSources { candidate_id, .. } => {
                let result = candidate_id.or(page.selected)
                    .and_then(|id| page.candidates.get(&id))
                    .map(|c| {
                        let views = page.views.borrow();
                        let mut media = views[&c.view].media.borrow_mut();
                        match candidate_id { Some(id) => media.candidate_sources(id, c.frame, &c.source.resource), None => media.sources(c.frame, &c.source.resource) }
                    })
                    .ok_or_else(|| "page_candidate_unavailable".into());
                let _ = reply.send(result);
            }
            Operation::PageSelect { candidate_id, original_page, resource_id, .. } => {
                if !page.candidates.contains_key(&candidate_id) {
                    let _ = reply.send(Err("page_candidate_unavailable".into()));
                    return;
                }
                if resource_id.is_some() {
                    page.request(Some(candidate_id), true, None, reply);
                    return;
                }
                if page.selected.is_some_and(|id| id != candidate_id) {
                    if let Err(error) = page
                        .views
                        .borrow_mut()
                        .get_mut(&page.selected_view())
                        .unwrap()
                        .release_mount()
                    {
                        let _ = reply.send(Err(error.to_string()));
                        return;
                    }
                    page.views.borrow()[&page.selected_view()]
                        .media
                        .borrow_mut()
                        .clear_selection();
                }
                page.selected = Some(candidate_id);
                page.original_page = original_page;
                page.candidates();
                page.request(None, true, None, reply);
            }
            Operation::PageRead { candidate_id, .. } => page.request(candidate_id, false, None, reply),
            Operation::PagePatch { patch, .. } => page.request(None, false, Some(patch), reply),
            Operation::PageHide { .. } => {
                let views = page.views.borrow();
                let view = page
                    .selected
                    .and_then(|id| page.candidates.get(&id))
                    .and_then(|candidate| views.get(&candidate.view))
                    .filter(|view| view.document.is_some());
                let result = view
                    .ok_or_else(|| "page_candidate_unavailable".to_owned())
                    .map(|_| {
                        for view in views.values() {
                            view.window.set_visible(false);
                        }
                        Value::Null
                    });
                let _ = reply.send(result);
            }
            Operation::PageFocus { .. } => {
                let mut views = page.views.borrow_mut();
                let view = views.get_mut(&page.selected_view()).unwrap();
                if let Err(error) = view.release_mount() {
                    let _ = reply.send(Err(error.to_string()));
                    return;
                }
                view.window.set_visible(true);
                view.window.set_minimized(false);
                view.window.set_focus();
                let _ = view.view.focus();
                let _ = reply.send(Ok(Value::Null));
            }
            _ => unreachable!(),
        }
    }
    fn publish(&mut self, page: Page, reply: Reply) {
        if reply.send(Ok(json!({"pageId":page.id}))).is_ok() {
            self.pages.insert(page.root, page);
        } else {
            page.record_retirement("prepare_cancelled");
        }
    }
    fn prepare(
        &mut self,
        owner: Uuid,
        id: Uuid,
        url: String,
        outgoing: page::Events,
        target: &EventLoopWindowTarget<ServiceEvent>,
        events: EventLoopProxy<ServiceEvent>,
    ) -> Result<Page> {
        if !page::valid_url(&url) {
            bail!("invalid_watch_url");
        }
        if self
            .pages
            .values()
            .any(|page| page.owner == owner && page.id == id)
        {
            bail!("page_player_exists");
        }
        if self.pages.len() >= page::MAX_PAGES {
            bail!("page_player_limit");
        }
        let key = Uuid::new_v4();
        let views: Views = Rc::default();
        let view = page_view(
            WebViewBuilder::new_with_web_context(&mut self.context).with_url("about:blank"),
            key,
            events,
            target,
        )?;
        media::observe(&view.view, view.media.clone(), id, outgoing.clone())?;
        view.view.load_url(&url)?;
        views.borrow_mut().insert(key, view);
        Ok(Page {
            root: key,
            requested_url: url,
            views,
            owner,
            origin: outgoing.origin.clone(),
            id,
            events: outgoing,
            candidates: BTreeMap::new(),
            selected: None,
            original_page: false,
            picker_document: None,
            pending: BTreeMap::new(),
        })
    }
    pub fn message(&mut self, view_key: Uuid, body: &str) {
        let Ok(message) = serde_json::from_str::<Message>(body) else {
            return;
        };
        if message.ancestors.len() > 32 {
            return;
        }
        let Some(key) = self
            .pages
            .iter()
            .find_map(|(key, page)| page.views.borrow().contains_key(&view_key).then_some(*key))
        else {
            return;
        };
        let page = self.pages.get_mut(&key).unwrap();
        let media = {
            let mut views = page.views.borrow_mut();
            let view = views.get_mut(&view_key).unwrap();
            if matches!(message.event, PageEvent::Document) {
                if message.document == message.frame && view.document.is_none() {
                    view.document = Some(message.document);
                    let origin = view
                        .view
                        .url()
                        .ok()
                        .and_then(|value| url::Url::parse(&value).ok())
                        .filter(|url| matches!(url.scheme(), "http" | "https"))
                        .map(|url| url.origin().ascii_serialization());
                    let title = origin.map_or_else(
                        || "Piik · Video".into(),
                        |origin| format!("Piik · Video — {origin}"),
                    );
                    view.window.set_title(&title);
                    view.caption.title(&title);
                }
                return;
            }
            if view.document != Some(message.document) {
                return;
            }
            view.media.clone()
        };
        retire_changed_candidate(&mut media.borrow_mut(), &page.candidates, message.frame, &message.event);
        match message.event {
            PageEvent::Resources { urls } => {
                let changed = media
                    .borrow_mut()
                    .frame(message.frame, message.ancestors, urls);
                if changed {
                    page.emit(json!({"type":"page_media_changed","pageId":page.id}));
                }
            }
            PageEvent::Removed { removed } => {
                media.borrow_mut().remove_frame(removed);
                page.candidates.retain(|_, candidate| {
                    candidate.view != view_key
                        || (candidate.frame != removed && !candidate.ancestors.contains(&removed))
                });
                if page
                    .selected
                    .is_some_and(|id| !page.candidates.contains_key(&id))
                    && !page.release_selection(view_key)
                {
                    self.retire_page(key, "selected_frame_removed");
                } else {
                    page.candidates();
                }
            }
            PageEvent::Candidates {
                candidates,
                removed,
            } => {
                if candidates.len() > MAX_PAGE_CANDIDATES || removed.len() > MAX_PAGE_CANDIDATES {
                    return;
                }
                if let Some(selected) = page.selected.and_then(|id| page.candidates.get_mut(&id))
                    .filter(|c| c.view == view_key && c.frame == message.frame)
                {
                    if let Some(next) = candidates.iter().find(|c| c.media == selected.source.media && c.resource.len() <= MAX_CANDIDATE_RESOURCE_BYTES) {
                        if !selected.source.observe_resource(next.revision, &next.resource, page.original_page, || {
                            page.views.borrow()[&view_key].media.borrow_mut().clear_selection();
                        }) {
                            self.retire_page(key, "selected_candidate_changed");
                            return;
                        }
                    }
                }
                if !update_candidates(
                    &mut page.candidates,
                    page.selected,
                    view_key,
                    message.frame,
                    &message.ancestors,
                    candidates,
                    &removed,
                ) && !page.release_selection(view_key) {
                    self.retire_page(key, "selected_candidate_changed");
                    return;
                }
                page.candidates();
            }
            PageEvent::Sample {
                media,
                resource,
                revision,
                event,
            } => {
                let Some(candidate_id) = media_candidate_id(&page.candidates, view_key, message.frame, media) else { return };
                if resource.len() > MAX_CANDIDATE_RESOURCE_BYTES {
                    return;
                }
                let candidate = page.candidates.get_mut(&candidate_id).unwrap();
                if page.selected == Some(candidate_id) {
                    if !candidate.source.observe_resource(revision, &resource, page.original_page, || {
                        page.views.borrow()[&view_key].media.borrow_mut().clear_selection();
                    }) {
                        self.retire_page(key, "selected_resource_changed");
                        return;
                    }
                } else {
                    candidate.source.revision = revision;
                    candidate.source.resource = resource;
                }
                page.emit(json!({"type":"page_sample","pageId":page.id,"candidateId":candidate_id,"event":event}));
            }
            PageEvent::Blocked { media } => {
                if let Some(candidate_id) = media_candidate_id(&page.candidates, view_key, message.frame, media) {
                    page.emit(json!({"type":"page_blocked","pageId":page.id,"candidateId":candidate_id}));
                }
            }
            PageEvent::Reply {
                request,
                state,
                error,
            } => {
                let Some(pending) = Pending::take_reply(&mut page.pending, request, view_key, message.frame) else { return };
                let result = if let Some(error) = error {
                    Err(anyhow!(page_reply_error(&error)))
                } else {
                    state
                        .ok_or_else(|| anyhow!("watch_media_failed"))
                        .and_then(|state| {
                            state.validate()?;
                            if pending.patch {
                                Ok(Value::Null)
                            } else {
                                Ok(serde_json::to_value(state)?)
                            }
                        })
                };
                let result = result.and_then(|value| {
                    if let Some((id, lifetime)) = &pending.promote {
                        if *lifetime.borrow() { bail!("watch_source_retired"); }
                        let id = *id;
                        let candidate = page.candidates.get(&id).ok_or_else(|| anyhow!("page_candidate_unavailable"))?;
                        let new_view = candidate.view;
                        let old_view = page.selected_view();
                        if page.selected != Some(id) {
                            let mut views = page.views.borrow_mut();
                            let old = views.get_mut(&old_view).ok_or_else(|| anyhow!("page_player_closed"))?;
                            old.release_mount()?;
                            old.media.borrow_mut().clear_selection();
                        }
                        page.views.borrow()[&new_view].media.borrow_mut().commit_candidate(id);
                        page.selected = Some(id);
                        page.original_page = false;
                        page.candidates();
                    }
                    Ok(value)
                });
                if result.is_err() && pending.selecting && pending.promote.is_none() {
                    page.selected = None;
                }
                let _ = pending
                    .reply
                    .send(result.map_err(|error| error.to_string()));
            }
            PageEvent::Document => {}
        }
    }
}

fn page_reply_error(error: &str) -> &'static str {
    match error {
        "page_candidate_unavailable" => "page_candidate_unavailable",
        "watch_autoplay_blocked" => "watch_autoplay_blocked",
        _ => "watch_media_failed",
    }
}

fn media_candidate_id(candidates: &BTreeMap<Uuid, Candidate>, view: Uuid, frame: Uuid, media: Uuid) -> Option<Uuid> {
    candidates.iter().find_map(|(id, candidate)|
        (candidate.view == view && candidate.frame == frame && candidate.source.media == media).then_some(*id))
}

fn candidate_catalog(
    page_id: Uuid, selected_view: Uuid, requested_url: &str,
    candidates: &BTreeMap<Uuid, Candidate>, page_urls: &BTreeMap<Uuid, String>,
) -> Value {
    // The catalog keeps a display address while about:blank has no original-page action.
    let url = page_urls.get(&selected_view).map(String::as_str).unwrap_or(requested_url);
    json!({"type":"page_candidates","pageId":page_id,"url":url,"candidates":candidate_descriptions(candidates, page_urls)})
}

fn candidate_descriptions(candidates: &BTreeMap<Uuid, Candidate>, page_urls: &BTreeMap<Uuid, String>) -> Vec<Value> {
    candidates.iter().map(|(id, candidate)| {
        json!({"id":id,"pageURL":page_urls.get(&candidate.view),"title":candidate.source.title,
            "url":candidate.source.url,"duration":candidate.source.duration})
    }).collect()
}

fn retire_changed_candidate(
    media: &mut media::Media,
    candidates: &BTreeMap<Uuid, Candidate>,
    frame: Uuid,
    event: &PageEvent,
) {
    let Some(id) = media.pending_candidate() else { return };
    let Some(candidate) = candidates.get(&id).filter(|candidate| candidate.frame == frame) else { return };
    let source = &candidate.source;
    let changed = match event {
        PageEvent::Candidates { candidates, removed } if candidates.len() <= MAX_PAGE_CANDIDATES && removed.len() <= MAX_PAGE_CANDIDATES =>
            removed.contains(&source.media) || candidates.iter().any(|next| next.media == source.media &&
                next.resource.len() <= MAX_CANDIDATE_RESOURCE_BYTES && source.replaces_resource(next.revision, &next.resource)),
        PageEvent::Sample { media, resource, revision, .. } if *media == source.media && resource.len() <= MAX_CANDIDATE_RESOURCE_BYTES =>
            source.replaces_resource(*revision, resource),
        _ => false,
    };
    if changed { media.cancel_candidate(id); }
}

impl ReportedCandidate {
    fn replaces_resource(&self, revision: u64, resource: &str) -> bool {
        self.revision != revision || !self.resource.is_empty() && self.resource != resource
    }
    fn observe_resource(&mut self, revision: u64, resource: &str, original_page: bool, revoke: impl FnOnce()) -> bool {
        if self.revision == revision && self.resource == resource {
            return true;
        }
        if self.replaces_resource(revision, resource) {
            if !original_page {
                return false;
            }
            revoke();
        }
        self.revision = revision;
        self.resource.clear();
        self.resource.push_str(resource);
        true
    }
}

// Each bounded bridge batch edits the same candidate map; missing batch entries are retained.
fn update_candidates(
    current: &mut BTreeMap<Uuid, Candidate>,
    selected: Option<Uuid>,
    view_key: Uuid,
    frame: Uuid,
    ancestors: &[Uuid],
    candidates: Vec<ReportedCandidate>,
    removed: &[Uuid],
) -> bool {
    current.retain(|_, candidate| {
        candidate.view != view_key
            || candidate.frame != frame
            || !removed.contains(&candidate.source.media)
    });
    let selected_present = selected.is_none_or(|id| current.contains_key(&id));
    for mut source in candidates {
        source.title = source.title.chars().take(256).collect();
        if source.url.as_ref().is_some_and(|url| !page::valid_url(url)) {
            source.url = None;
        }
        if source.duration.is_some_and(|v| !v.is_finite() || v < 0.) {
            source.duration = None;
        }
        if source.resource.len() > MAX_CANDIDATE_RESOURCE_BYTES {
            continue;
        }
        let previous = current.iter().find(|(_, candidate)| {
            candidate.view == view_key
                && candidate.frame == frame
                && candidate.source.media == source.media
        });
        if previous.is_some_and(|(id, old)| {
            selected == Some(*id)
                && old.source.replaces_resource(source.revision, &source.resource)
        }) {
            return false;
        }
        let id = match previous {
            Some((id, _)) => *id,
            None if current.len() < MAX_PAGE_CANDIDATES => Uuid::new_v4(),
            None => continue,
        };
        current.insert(
            id,
            Candidate {
                view: view_key,
                frame,
                ancestors: ancestors.to_vec(),
                source,
            },
        );
    }

    selected_present
}

fn allows_page_navigation(url: &str) -> bool {
    // Login flows can open a blank child before assigning its HTTPS destination.
    url == "about:blank" || page::valid_url(url)
}

fn process_ended_view(kind: COREWEBVIEW2_PROCESS_FAILED_KIND) -> bool {
    matches!(
        kind,
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED
            | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
    )
}

fn page_view(
    builder: WebViewBuilder<'_>,
    key: Uuid,
    events: EventLoopProxy<ServiceEvent>,
    target: &EventLoopWindowTarget<ServiceEvent>,
) -> Result<PageView> {
    let controls: WindowControls = serde_json::from_str(super::CONTROLS)?;
    let window = super::window_builder()?
        .with_title("Piik · Video")
        .with_decorations(false)
        .with_undecorated_shadow(true)
        .with_inner_size(caption::window_size(
            LogicalSize::new(1000., 720.),
            &controls,
        ))
        .build(target)?;
    let messages = events.clone();
    let navigating = events.clone();
    let media = Rc::new(RefCell::new(media::Media::default()));
    let view = builder
        .with_initialization_script_for_main_only(include_str!("page-player.js"), false)
        .with_ipc_handler(move |request| {
            if request.body().len() <= 65536 {
                let _ = messages.send_event(ServiceEvent::PageMessage(key, request.into_body()));
            }
        })
        .with_navigation_handler(|url| allows_page_navigation(&url))
        .with_on_page_load_handler(move |event, _| {
            if matches!(event, wry::PageLoadEvent::Started) {
                let _ = navigating.send_event(ServiceEvent::PageNavigate(key));
            }
        })
        .build_as_child(&window)?;
    super::download::install(&view, None, None)?;
    let caption = caption::Caption::new(&window, &view, events.clone(), &controls, true)?;
    caption.title("Piik · Video");
    caption.layout(&window, &view, &controls);
    let popups = Rc::new(RefCell::new(VecDeque::new()));
    let pending = popups.clone();
    let popup_events = events.clone();
    let window_id = window.id();
    let failures = events.clone();
    let mut process_failed_token = 0;
    unsafe {
        website_permissions(&view)?;
        view.webview().add_NewWindowRequested(
            &NewWindowRequestedEventHandler::create(Box::new(move |sender, args| {
                let (Some(sender), Some(args)) = (sender, args) else {
                    return Ok(());
                };
                args.SetHandled(true)?;
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let uri = webview2_com::take_pwstr(uri);
                if !allows_page_navigation(&uri) || pending.borrow().len() >= MAX_PENDING_POPUPS {
                    return Ok(());
                }
                let environment = sender.cast::<ICoreWebView2_2>()?.Environment()?;
                let popup = Popup {
                    deferral: args.GetDeferral()?,
                    environment,
                    args,
                };
                pending.borrow_mut().push_back(popup);
                if popup_events
                    .send_event(ServiceEvent::PagePopup(key))
                    .is_err()
                {
                    let failed = pending.borrow_mut().pop_back();
                    drop(failed);
                }
                Ok(())
            })),
            &mut Default::default(),
        )?;
        view.webview().add_WindowCloseRequested(
            &WindowCloseRequestedEventHandler::create(Box::new(move |_, _| {
                let _ = events.send_event(ServiceEvent::PopupClosed(window_id));
                Ok(())
            })),
            &mut Default::default(),
        )?;
        view.webview().add_ProcessFailed(
            &ProcessFailedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                    args.ProcessFailedKind(&mut kind)?;
                    if process_ended_view(kind) {
                        let _ = failures.send_event(ServiceEvent::PageProcessExited(key));
                    }
                }
                Ok(())
            })),
            &mut process_failed_token,
        )?;
    }
    Ok(PageView {
        process_failed_token,
        popups,
        caption,
        view,
        window,
        document: None,
        mounted: None,
        media,
    })
}

fn website_permissions(view: &WebView) -> Result<()> {
    unsafe {
        view.webview().add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                    args.cast::<ICoreWebView2PermissionRequestedEventArgs3>()?
                        .SetSavesInProfile(false)?;
                }
                Ok(())
            })),
            &mut Default::default(),
        )?;
    }
    Ok(())
}

#[test]
fn login_popup_can_start_blank_and_navigate_to_https() {
    assert!(allows_page_navigation("about:blank"));
    assert!(allows_page_navigation("https://login.example/"));
    assert!(!allows_page_navigation("about:settings"));
    assert!(!page::valid_url("about:blank"));
}

#[cfg(test)]
#[test]
fn whole_webview_process_exits_retire_the_view() {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    assert!(process_ended_view(COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED));
    assert!(process_ended_view(COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED));
    for kind in [
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
    ] {
        assert!(!process_ended_view(kind));
    }
}

#[cfg(test)]
#[tokio::test]
#[ignore = "opens a WebView2 window on an interactive Windows desktop"]
async fn cancelled_prepare_and_queued_close_release_native_windows() {
    use axum::{response::Html, routing::get, Router};
    use futures_util::FutureExt;
    use std::{
        collections::HashSet,
        sync::Arc,
        time::{Duration, Instant},
    };
    use tao::{
        event::{Event, WindowEvent},
        event_loop::{ControlFlow, EventLoopBuilder},
        platform::{run_return::EventLoopExtRunReturn, windows::EventLoopBuilderExtWindows},
    };
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;
    use webview2_com::{
        BrowserProcessExitedEventHandler,
        Microsoft::Web::WebView2::Win32::ICoreWebView2Environment5,
    };

    struct FixtureServer {
        stop: CancellationToken,
        thread: Option<std::thread::JoinHandle<()>>,
    }
    impl Drop for FixtureServer {
        fn drop(&mut self) {
            self.stop.cancel();
            let result = self.thread.take().unwrap().join();
            if !std::thread::panicking() {
                result.unwrap();
            }
        }
    }
    // Tao blocks this test's Tokio thread while it pumps WebView2 callbacks.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let fixture_url = format!("http://{}/", listener.local_addr().unwrap());
    let stop = CancellationToken::new();
    let shutdown = stop.clone();
    let fixture = FixtureServer {
        stop,
        thread: Some(std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async move {
                    let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                    let router = Router::new().route("/", get(|| async {
                        Html(include_str!("test-original-page.html"))
                    }));
                    tokio::select! {
                        result = axum::serve(listener, router) => result.unwrap(),
                        _ = shutdown.cancelled() => {}
                    }
                });
        })),
    };

    let profile = tempfile::Builder::new()
        .prefix("piik-page-lifetime-")
        .tempdir()
        .unwrap();
    let mut target = EventLoopBuilder::<ServiceEvent>::with_user_event()
        .with_any_thread(true)
        .build();
    let mut pages = Pages::new(profile.path().to_owned());
    // Only the packaged App binary links the Windows icon resource.
    super::APP_ICON.with(|icon| {
        *icon.borrow_mut() = Some(tao::window::Icon::from_rgba(vec![0; 4], 1, 1).unwrap());
    });
    let (dispatch, mut commands) = mpsc::unbounded_channel();
    let (outgoing, mut events) = mpsc::channel(32);
    let connection = page::Connection::new(
        Some(Arc::new(move |cmd| dispatch.send(cmd).is_ok())),
        outgoing,
    );
    let page_id = Uuid::new_v4();
    let prepare = Operation::PagePrepare {
        page_id,
        url: "http://127.0.0.1:1/".into(),
    };

    let mut pending = Box::pin(connection.request(prepare.clone()));
    assert!(futures_util::poll!(&mut pending).is_pending());
    let Command::Request {
        owner,
        operation: Operation::PagePrepare { url, .. },
        events: outgoing,
        reply,
    } = commands.try_recv().unwrap()
    else {
        panic!("expected prepare")
    };
    let window = pages
        .prepare(
            owner,
            page_id,
            url,
            outgoing,
            &target,
            target.create_proxy(),
        )
        .unwrap();
    let mut windows = HashSet::from([window.views.borrow()[&window.root].window.id()]);
    assert_eq!(
        pending.await.unwrap_err().to_string(),
        "page_player_timeout"
    );
    pages.publish(window, reply);
    assert!(pages.pages.is_empty());
    assert_eq!(events.try_recv().unwrap()["type"], "page_closed");

    let mut loaded = Box::pin(connection.request(prepare.clone()));
    assert!(futures_util::poll!(&mut loaded).is_pending());
    pages.operation(commands.try_recv().unwrap(), &target, target.create_proxy());
    loaded.await.unwrap();
    let loading = pages.pages.values().next().unwrap();
    let view = loading.root;
    windows.insert(loading.views.borrow()[&view].window.id());
    let (frame, media) = (Uuid::new_v4(), Uuid::new_v4());
    let send = |pages: &mut Pages, mut message: Value| {
        message["document"] = json!(frame);
        message["frame"] = json!(frame);
        pages.message(view, &message.to_string());
    };
    send(&mut pages, json!({"kind":"document"}));
    send(
        &mut pages,
        json!({"kind":"candidates","removed":[],"candidates":[{"media":media,"resource":"","revision":0,"title":"Loading video"}]}),
    );
    let loading = pages.pages.get_mut(&view).unwrap();
    let selected = *loading.candidates.keys().next().unwrap();
    loading.selected = Some(selected);
    // Two immediate samples can arrive before the next batched candidate report.
    let sample = |resource: &str| json!({"kind":"sample","media":media,"resource":resource,"revision":0,"event":"loadedmetadata"});
    send(&mut pages, sample("blob:first"));
    assert_eq!(
        pages.pages[&view].candidates[&selected].source.resource,
        "blob:first"
    );
    send(&mut pages, sample("blob:second"));
    assert!(pages.pages.is_empty());
    assert!(
        std::iter::from_fn(|| events.try_recv().ok()).any(|event| event["type"] == "page_closed")
    );

    let mut retry = Box::pin(connection.request(prepare));
    assert!(futures_util::poll!(&mut retry).is_pending());
    pages.operation(commands.try_recv().unwrap(), &target, target.create_proxy());
    assert_eq!(retry.await.unwrap()["pageId"], json!(page_id));
    assert_eq!(pages.pages.len(), 1);
    let reopened = pages.pages.values_mut().next().unwrap();
    let opener = reopened.views.borrow()[&reopened.root].window.id();
    windows.insert(opener);
    let environment = reopened.views.borrow()[&reopened.root]
        .view
        .environment()
        .cast::<ICoreWebView2Environment5>()
        .unwrap();
    let browser_exited = Rc::new(std::cell::Cell::new(false));
    let exited = browser_exited.clone();
    unsafe {
        environment
            .add_BrowserProcessExited(
                &BrowserProcessExitedEventHandler::create(Box::new(move |_, _| {
                    exited.set(true);
                    Ok(())
                })),
                &mut 0,
            )
            .unwrap();
    }

    let child = Uuid::new_v4();
    let view = page_view(
        WebViewBuilder::new().with_environment(environment.cast().unwrap()),
        child,
        target.create_proxy(),
        &target,
    )
    .unwrap();
    let child_window = view.window.id();
    windows.insert(child_window);
    view.window.set_visible(true);
    reopened.views.borrow_mut().insert(child, view);
    reopened.views.borrow()[&child].view.load_url(&fixture_url).unwrap();

    // Dispatch the same WebView2 callbacks as the App while waiting for media
    // and command replies. Retain the destruction notifications for cleanup.
    let mut pump = |pages: &mut Pages, stage: &str, done: &mut dyn FnMut(&Pages, Option<&Value>) -> bool| {
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut complete = false;
        let mut discovery = Vec::new();
        let proxy = target.create_proxy();
        target.run_return(|event, target, flow| {
            match event {
                Event::UserEvent(ServiceEvent::PageMessage(id, body)) => {
                    pages.message(id, &body);
                    if stage == "video discovery" && id == child && discovery.len() < 16 {
                        let packet: Value = serde_json::from_str(&body).unwrap_or_default();
                        let page = pages.pages.values().next().unwrap();
                        let document = page.views.borrow()[&child].document;
                        let same_document = document.is_some_and(|id| packet["document"] == json!(id));
                        let candidates = page.candidates.values().filter(|c| c.view == child).count();
                        discovery.push(format!(
                            "{} matched_document={same_document} candidates={candidates}", packet["kind"],
                        ));
                    }
                }
                Event::UserEvent(ServiceEvent::PageNavigate(id)) => {
                    if stage == "video discovery" && id == child && discovery.len() < 16 {
                        discovery.push("navigate".into());
                    }
                    pages.navigate(id);
                }
                Event::UserEvent(ServiceEvent::PageProcessExited(id)) => pages.process_exited(id),
                Event::WindowEvent { event: WindowEvent::Destroyed, window_id, .. } => {
                    windows.remove(&window_id);
                }
                _ => {}
            }
            while let Ok(command) = commands.try_recv() {
                pages.command(command, target, proxy.clone());
            }
            for event in std::iter::from_fn(|| events.try_recv().ok()) {
                assert_ne!(event["type"], "page_closed", "page closed during {stage}");
                assert_ne!(event["type"], "page_selection_lost", "selection lost during {stage}");
                complete |= done(pages, Some(&event));
            }
            if !complete {
                complete = done(pages, None);
            }
            *flow = if complete || Instant::now() >= deadline {
                ControlFlow::Exit
            } else {
                ControlFlow::WaitUntil(deadline)
            };
        });
        assert!(complete, "timed out during {stage}, child discovery events {discovery:?}");
    };
    let mut candidate = None;
    pump(&mut pages, "video discovery", &mut |pages, _| {
        candidate = pages.pages.values().next().and_then(|page| {
            page.candidates.iter().find(|(_, candidate)| candidate.view == child).map(|(id, _)| *id)
        });
        candidate.is_some()
    });
    let candidate = candidate.unwrap();
    let script = |pages: &Pages, code: &str| {
        pages.pages.values().next().unwrap().views.borrow()[&child]
            .view.evaluate_script(code).unwrap();
    };
    let is_sample = |event: Option<&Value>, kind: &str| {
        event.is_some_and(|event| {
            event["type"] == "page_sample" && event["event"] == kind
                && event["pageId"] == json!(page_id) && event["candidateId"] == json!(candidate)
        })
    };
    script(&pages, "playFixture()");
    pump(&mut pages, "initial paused video", &mut |_, event| is_sample(event, "pause"));

    let mut selected = Box::pin(connection.request(Operation::PageSelect {
        page_id, candidate_id: candidate, original_page: true, resource_id: None,
    }));
    assert!(futures_util::poll!(&mut selected).is_pending());
    let mut state = None;
    pump(&mut pages, "original-page selection", &mut |_, _| {
        state = state.take().or_else(|| selected.as_mut().now_or_never());
        state.is_some()
    });
    let state = state.unwrap().unwrap();
    assert_eq!(state["paused"], true);
    assert!(state["readyState"].as_u64().unwrap() >= 2, "{state}");
    for (code, sample, stage) in [
        ("emptyFixture()", "emptied", "empty selected video"),
        ("playFixture()", "loadeddata", "restored selected video"),
    ] {
        let retired = pages.pages.values().next().unwrap().views.borrow()[&child]
            .media.borrow().retired.subscribe();
        assert!(!*retired.borrow(), "media lifetime already retired before {stage}");

        script(&pages, code);
        let mut sampled = false;
        pump(&mut pages, stage, &mut |_, event| {
            sampled |= is_sample(event, sample);
            sampled && (sample == "emptied" || is_sample(event, "pause"))
        });
        assert!(*retired.borrow(), "resource replacement retained the old media lifetime");
        let mut request = Box::pin(connection.request(Operation::PageRead { page_id, candidate_id: None }));
        assert!(futures_util::poll!(&mut request).is_pending());
        let mut state = None;
        pump(&mut pages, stage, &mut |_, _| {
            state = state.take().or_else(|| request.as_mut().now_or_never());
            state.is_some()
        });
        let state = state.unwrap().unwrap();
        assert_eq!(state["paused"], true);
        let readiness = state["readyState"].as_u64().unwrap();
        if sample == "emptied" {
            assert_eq!(readiness, 0, "{state}");
        } else {
            assert!(readiness >= 2, "{state}");
        }
    }
    let page = pages.pages.values().next().unwrap();
    assert_eq!(page.selected, Some(candidate));
    let (child_frame, child_media) = (page.candidates[&candidate].frame, page.candidates[&candidate].source.media);
    let retired = page.views.borrow()[&child].media.borrow().retired.subscribe();
    for (operation, visible) in [
        (Operation::PageHide { page_id }, false),
        (Operation::PageFocus { page_id }, true),
    ] {
        let mut request = Box::pin(connection.request(operation));
        assert!(futures_util::poll!(&mut request).is_pending());
        pages.operation(commands.try_recv().unwrap(), &target, target.create_proxy());
        request.await.unwrap();
        assert_eq!(
            pages.pages.values().next().unwrap().views.borrow()[&child]
                .window
                .is_visible(),
            visible
        );
        assert!(!*retired.borrow());
        let page = pages.pages.values().next().unwrap();
        assert!(!page.views.borrow()[&page.root].window.is_visible());
    }

    let opener_view = pages.pages.values().next().unwrap().root;
    pages.process_exited(opener_view);
    pages.process_exited(opener_view);
    assert!(!pages.close_window(opener));
    assert!(
        !*retired.borrow(),
        "closing the opener retired the selected popup"
    );
    assert_eq!(pages.pages.values().next().unwrap().selected_view(), child);
    let catalog = events.try_recv().unwrap();
    assert_eq!(catalog["type"], "page_candidates");
    assert_eq!(catalog["candidates"][0]["id"], json!(candidate));

    // A frame can report candidate loss before the next catalog, or the catalog can arrive first.
    let mut read = Box::pin(connection.request(Operation::PageRead { page_id, candidate_id: Some(candidate) }));
    assert!(futures_util::poll!(&mut read).is_pending());
    pages.operation(commands.try_recv().unwrap(), &target, target.create_proxy());
    let request = *pages.pages.values().next().unwrap().pending.keys().next().unwrap();
    pages.message(child, &json!({
        "kind":"reply", "document":child_frame, "frame":child_frame,
        "request":request, "error":"page_candidate_unavailable"
    }).to_string());
    let frame_error = read.await.unwrap_err().to_string();

    let mut select = Box::pin(connection.request(Operation::PageSelect {
        page_id, candidate_id: candidate, original_page: true, resource_id: None,
    }));
    assert!(futures_util::poll!(&mut select).is_pending());
    pages.operation(commands.try_recv().unwrap(), &target, target.create_proxy());
    assert_eq!(events.try_recv().unwrap()["type"], "page_candidates");
    pages.message(child, &json!({
        "kind":"candidates", "document":child_frame, "frame":child_frame,
        "candidates":[], "removed":[child_media]
    }).to_string());
    let catalog_error = select.await.unwrap_err().to_string();
    let selection_lost = events.try_recv().unwrap();
    let empty_catalog = events.try_recv().unwrap();
    let page = pages.pages.values().next().unwrap();
    let retired = page.views.borrow()[&child].media.borrow().retired.subscribe();
    assert!(!*retired.borrow(), "media lifetime already retired before page close");

    let mut close = Box::pin(connection.request(Operation::PageClose { page_id }));
    assert!(futures_util::poll!(&mut close).is_pending());
    assert_eq!(close.await.unwrap_err().to_string(), "page_player_timeout");
    pages.operation(commands.try_recv().unwrap(), &target, target.create_proxy());
    assert!(pages.pages.is_empty());
    assert!(*retired.borrow());
    assert_eq!(events.try_recv().unwrap()["type"], "page_closed");
    drop(pages);
    let deadline = Instant::now() + Duration::from_secs(5);
    target.run_return(|event, _, flow| {
        if let Event::WindowEvent {
            event: WindowEvent::Destroyed,
            window_id,
            ..
        } = event
        {
            windows.remove(&window_id);
        }
        *flow = if (windows.is_empty() && browser_exited.get()) || Instant::now() >= deadline {
            ControlFlow::Exit
        } else {
            ControlFlow::WaitUntil(deadline)
        };
    });
    assert!(windows.is_empty(), "Tao did not destroy all test windows");
    assert!(
        browser_exited.get(),
        "WebView2 still owns the temporary profile"
    );
    drop(environment);
    profile.close().unwrap();
    drop(fixture);
    assert_eq!(frame_error, "page_candidate_unavailable");
    assert_eq!(catalog_error, "page_candidate_unavailable");
    assert_eq!(selection_lost["type"], "page_selection_lost");
    assert_eq!(selection_lost["candidateId"], json!(candidate));
    assert_eq!(empty_catalog["type"], "page_candidates");
    assert_eq!(empty_catalog["candidates"], json!([]));
}

#[cfg(test)]
mod candidate_tests {
    use super::*;
    fn report(media: Uuid, url: &str) -> ReportedCandidate {
        ReportedCandidate {
            media,
            resource: url.into(),
            revision: 0,
            title: "Owned video".into(),
            url: Some(url.into()),
            duration: Some(30.),
        }
    }
    #[test]
    fn candidate_page_urls_follow_the_native_view_without_hiding_unaddressable_players() {
        let (root, popup, transient, frame) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let candidates = BTreeMap::from([(a, root), (b, popup), (c, transient)].map(|(id, view)| (id, Candidate {
            view, frame, ancestors: vec![], source: report(Uuid::new_v4(), "https://media.test/video.mp4"),
        })));
        let mut addresses = BTreeMap::from([(root, "https://site.test/home".into()), (popup, "https://popup.test/episode".into())]);
        let describe = |addresses: &BTreeMap<Uuid, String>, id| candidate_descriptions(&candidates, addresses)
            .into_iter().find(|value| value["id"] == json!(id)).unwrap();
        assert_eq!(describe(&addresses, b)["pageURL"], "https://popup.test/episode");
        assert_eq!(describe(&addresses, b)["url"], "https://media.test/video.mp4");
        assert!(describe(&addresses, c)["pageURL"].is_null());
        assert_eq!(describe(&addresses, c)["url"], "https://media.test/video.mp4");
        addresses.insert(popup, "https://popup.test/next".into());
        assert_eq!(describe(&addresses, b)["pageURL"], "https://popup.test/next");
        assert_eq!(describe(&addresses, a)["pageURL"], "https://site.test/home");
    }
    #[test]
    fn blank_opener_publishes_popup_then_empty_catalog_when_popup_closes() {
        let (page_id, opener, popup, id) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let requested_url = "https://site.test/open";
        let popup_url = "https://popup.test/episode";
        let candidate = Candidate {
            view: popup, frame: Uuid::new_v4(), ancestors: vec![],
            source: report(Uuid::new_v4(), "https://media.test/video.mp4"),
        };
        // about:blank is excluded from the per-window navigable addresses.
        let mut addresses = BTreeMap::from([(popup, popup_url.to_owned())]);
        let mut candidates = BTreeMap::from([(id, candidate)]);
        let event = candidate_catalog(page_id, opener, requested_url, &candidates, &addresses);
        assert_eq!(event["candidates"][0]["pageURL"], popup_url);
        assert_eq!(event["url"], requested_url);

        addresses.remove(&popup);
        candidates.remove(&id);
        let event = candidate_catalog(page_id, opener, requested_url, &candidates, &addresses);
        assert_eq!(event, json!({"type":"page_candidates","pageId":page_id,"url":requested_url,"candidates":[]}));
    }
    #[test]
    fn media_events_require_an_observed_candidate_in_the_same_view_and_frame() {
        let (view, popup, frame, media) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let mut candidates = BTreeMap::from([(a, view), (b, popup)].map(|(id, view)| (id, Candidate {
            view, frame, ancestors: vec![], source: report(media, "https://media.test/video.mp4"),
        })));
        assert_eq!(media_candidate_id(&candidates, view, frame, media), Some(a));
        assert_eq!(media_candidate_id(&candidates, popup, frame, media), Some(b));
        assert_eq!(media_candidate_id(&candidates, popup, Uuid::new_v4(), media), None);
        assert_eq!(media_candidate_id(&candidates, popup, frame, Uuid::new_v4()), None);
        candidates.remove(&b);
        assert_eq!(media_candidate_id(&candidates, popup, frame, media), None);
        assert_eq!(media_candidate_id(&candidates, view, frame, media), Some(a));
    }
    #[test]
    fn bounded_batches_preserve_first_selection_and_retire_only_its_actual_removal() {
        let (view, frame, sibling) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let mut candidates = BTreeMap::new();
        let media: Vec<_> = (0..12).map(|_| Uuid::new_v4()).collect();
        let url = format!("https://media.test/video?signature={}", "a".repeat(3900));
        let batch = |ids: &[Uuid]| ids.iter().map(|id| report(*id, &url)).collect();
        assert!(update_candidates(
            &mut candidates,
            None,
            view,
            frame,
            &[],
            batch(&media[..6]),
            &[]
        ));
        let selected = *candidates
            .iter()
            .find(|(_, c)| c.source.media == media[0])
            .unwrap()
            .0;
        // The next IPC batch is not an empty/full replacement of the first one.
        assert!(update_candidates(
            &mut candidates,
            Some(selected),
            view,
            frame,
            &[],
            batch(&media[6..]),
            &[]
        ));
        assert_eq!(candidates.len(), 12);
        assert!(update_candidates(
            &mut candidates,
            Some(selected),
            sibling,
            frame,
            &[],
            vec![],
            &[media[0]]
        ));
        assert!(update_candidates(
            &mut candidates,
            Some(selected),
            view,
            sibling,
            &[],
            vec![],
            &[media[0]]
        ));
        assert!(candidates.contains_key(&selected));
        assert!(!update_candidates(
            &mut candidates,
            Some(selected),
            view,
            frame,
            &[],
            vec![],
            &[media[0]]
        ));
        assert!(!candidates.contains_key(&selected));
    }
    #[test]
    fn removed_selection_keeps_the_replacement_candidate_in_the_same_batch() {
        let (view, frame, old, next) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let mut candidates = BTreeMap::new();
        assert!(update_candidates(&mut candidates, None, view, frame, &[], vec![report(old, "https://media.test/old")], &[]));
        let selected = *candidates.keys().next().unwrap();
        assert!(!update_candidates(&mut candidates, Some(selected), view, frame, &[], vec![report(next, "https://media.test/next")], &[old]));
        assert!(!candidates.contains_key(&selected));
        let replacement = candidates.values().next().unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(replacement.source.media, next);
        assert_eq!(replacement.source.resource, "https://media.test/next");
    }
    #[test]
    fn repeated_resource_observations_revoke_once() {
        let mut source = report(Uuid::new_v4(), "A");
        let mut revoked = 0;
        for (revision, resource) in [(1, ""), (1, ""), (1, "B"), (1, "B")] {
            assert!(source.observe_resource(revision, resource, true, || revoked += 1));
        }
        assert_eq!(revoked, 1);
        assert_eq!(source.resource, "B");
        assert!(!source.observe_resource(2, "C", false, || panic!("provider retires its page")));
    }
    #[test]
    fn staged_candidate_reader_follows_resource_and_element_lifetime() {
        let (id, element, frame) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let candidates = BTreeMap::from([(id, Candidate {
            view: Uuid::new_v4(), frame, ancestors: vec![], source: report(element, "first"),
        })]);
        let mut media = media::Media::default();
        let current_reader = media.retired.subscribe();
        let reports = |candidates, removed| PageEvent::Candidates { candidates, removed };
        for event in [
            reports(vec![report(element, "second")], vec![]),
            PageEvent::Sample { media: element, resource: "second".into(), revision: 1, event: MediaEvent::Loadedmetadata },
            reports(vec![], vec![element]),
        ] {
            media.candidate_sources(id, frame, "first");
            let pending = media.candidate_lifetime(id).unwrap();
            retire_changed_candidate(&mut media, &candidates, frame, &reports(vec![], vec![Uuid::new_v4()]));
            assert!(!*pending.borrow());
            retire_changed_candidate(&mut media, &candidates, frame, &event);
            assert!(*pending.borrow());
            assert!(media.candidate_lifetime(id).is_none());
            assert!(!*current_reader.borrow());
        }
    }
    #[test]
    fn candidate_removal_settles_its_pending_read_and_preserves_the_sibling() {
        let view = Uuid::new_v4();
        let frame = Uuid::new_v4();
        let sibling = Uuid::new_v4();
        let candidates = BTreeMap::from([(sibling, Candidate {
            view, frame, ancestors: vec![], source: report(Uuid::new_v4(), "https://media.test/b"),
        })]);
        let mut requests = BTreeMap::new();
        let mut read = |candidate_id| {
            let request = Uuid::new_v4();
            let (reply, receiver) = oneshot::channel();
            requests.insert(request, Pending {
                view, frame, candidate_id, reply, selecting: true, promote: None, patch: false,
            });
            (request, receiver)
        };
        let (removed, mut removed_reply) = read(Uuid::new_v4());
        let (kept, mut kept_reply) = read(sibling);

        Pending::retire_missing_candidates(&mut requests, &candidates);
        assert_eq!(removed_reply.try_recv().unwrap(), Err("page_candidate_unavailable".into()));
        assert!(Pending::take_reply(&mut requests, removed, view, frame).is_none());
        let pending = Pending::take_reply(&mut requests, kept, view, frame).unwrap();
        pending.reply.send(Ok(Value::Null)).unwrap();
        assert_eq!(kept_reply.try_recv().unwrap(), Ok(Value::Null));
    }

    #[test]
    fn frame_reply_preserves_candidate_loss_and_normalizes_unknown_errors() {
        assert_eq!(page_reply_error("page_candidate_unavailable"), "page_candidate_unavailable");
        assert_eq!(page_reply_error("watch_autoplay_blocked"), "watch_autoplay_blocked");
        assert_eq!(page_reply_error("page_player_closed"), "watch_media_failed");
    }

    #[test]
    fn cancelled_selection_reply_preserves_active_grant() {
        let (view, frame, candidate) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let mut media = media::Media::default();
        let active = media.retired.subscribe();
        media.candidate_sources(candidate, frame, "second");
        let staged = media.candidate_lifetime(candidate).unwrap();
        let mut requests = BTreeMap::new();
        for cancelled in [true, false] {
            let request = Uuid::new_v4();
            let (reply, receiver) = oneshot::channel();
            let mut receiver = Some(receiver);
            requests.insert(request, Pending {
                view, candidate_id: candidate, frame, reply, selecting: true, promote: Some((candidate, staged.clone())), patch: false,
            });
            if cancelled { drop(receiver.take()); }
            if let Some(pending) = Pending::take_reply(&mut requests, request, view, frame) {
                media.commit_candidate(pending.promote.unwrap().0);
                pending.reply.send(Ok(Value::Null)).unwrap();
            }
            assert!(requests.is_empty());
            assert_eq!(*active.borrow(), !cancelled);
            assert!(!*staged.borrow());
            if let Some(mut receiver) = receiver { assert!(receiver.try_recv().unwrap().is_ok()); }
        }
    }
    #[test]
    fn same_media_resource_replacement_retires_selected_but_sibling_update_does_not() {
        let (view, frame, media, other) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        let mut candidates = BTreeMap::new();
        assert!(update_candidates(
            &mut candidates,
            None,
            view,
            frame,
            &[],
            vec![
                report(media, "https://media.test/a"),
                report(other, "https://media.test/b")
            ],
            &[]
        ));
        let selected = *candidates
            .iter()
            .find(|(_, c)| c.source.media == media)
            .unwrap()
            .0;
        assert!(update_candidates(
            &mut candidates,
            Some(selected),
            view,
            frame,
            &[],
            vec![report(other, "https://media.test/c")],
            &[]
        ));
        assert!(!update_candidates(
            &mut candidates,
            Some(selected),
            view,
            frame,
            &[],
            vec![report(media, "https://media.test/new")],
            &[]
        ));
    }
}
