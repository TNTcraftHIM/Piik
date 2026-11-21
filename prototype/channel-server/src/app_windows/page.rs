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
        COREWEBVIEW2_PERMISSION_STATE_DENY,
    },
    NewWindowRequestedEventHandler, PermissionRequestedEventHandler,
    WindowCloseRequestedEventHandler,
};
use windows_core::{Interface, PWSTR};
use wry::{WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};

type Views = Rc<RefCell<BTreeMap<Uuid, PageView>>>;
type Reply = oneshot::Sender<Result<Value, String>>;
const MAX_PAGE_VIEWS: usize = 64;
const MAX_PENDING_POPUPS: usize = 64;
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
    title: String,
    url: Option<String>,
    duration: Option<f64>,
}
#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum MediaEvent {
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
    reply: Reply,
    frame: Uuid,
    selecting: bool,
    patch: bool,
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
            self.view.set_visible(false)?;
            if let Err(error) = self.view.reparent(parent) {
                let _ = self.view.set_visible(true);
                return Err(error.into());
            }
            self.mounted = Some((parent, standalone_bounds));
            self.window.set_visible(false);
        }
        if let Err(error) = self
            .view
            .set_bounds(bounds)
            .and_then(|()| self.view.set_visible(true))
        {
            let _ = self.release_mount();
            return Err(error.into());
        }
        Ok(())
    }

    fn release_mount(&mut self) -> Result<()> {
        if let Some((_, bounds)) = self.mounted {
            self.view.set_visible(false)?;
            self.view.reparent(self.window.hwnd())?;
            self.mounted = None;
            self.view.set_bounds(bounds)?;
            self.view.set_visible(true)?;
        }
        Ok(())
    }
}

impl Drop for PageView {
    fn drop(&mut self) {
        let pending = std::mem::take(&mut *self.popups.borrow_mut());
        drop(pending);
        self.media.borrow().retired.send_replace(true);
    }
}
struct Page {
    root: Uuid,
    views: Views,
    owner: Uuid,
    origin: String,
    id: Uuid,
    events: page::Events,
    candidates: BTreeMap<Uuid, Candidate>,
    selected: Option<Uuid>,
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
    fn candidates(&self) {
        let views = self.views.borrow();
        let Some(url) = views
            .get(&self.selected_view())
            .and_then(|view| view.view.url().ok())
            .filter(|url| page::valid_url(url))
        else {
            return;
        };
        self.emit(json!({"type":"page_candidates","pageId":self.id,"url":url,"candidates":self.candidates.iter().map(|(id,c)|json!({"id":id,"title":c.source.title,"url":c.source.url,"duration":c.source.duration})).collect::<Vec<_>>()}));
    }
    fn request(&mut self, selecting: bool, patch: Option<page::Patch>, reply: Reply) {
        self.pending.retain(|_, pending| !pending.reply.is_closed());
        let Some(candidate) = self.selected.and_then(|id| self.candidates.get(&id)) else {
            let _ = reply.send(Err("page_candidate_unavailable".into()));
            return;
        };
        if self.pending.len() >= 64 {
            let _ = reply.send(Err("page_player_busy".into()));
            return;
        }
        let request = Uuid::new_v4();
        let command = json!({"bridge":"piik-page-command","kind":if patch.is_some(){"patch"}else{"read"},"frame":candidate.frame,"media":candidate.source.media,"request":request,"patch":patch});
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
                        reply,
                        frame: candidate.frame,
                        selecting,
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
        self.pages.clear();
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

    pub fn release_mounts(&mut self) {
        for page in self.pages.values() {
            for view in page.views.borrow_mut().values_mut() {
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
        let page = self.pages.get_mut(&key).unwrap();
        if view == page.root || page.selected_view() == view {
            self.pages.remove(&key);
        } else {
            page.candidates
                .retain(|_, candidate| candidate.view != view);
            let removed = page.views.borrow_mut().remove(&view);
            drop(removed);
            page.candidates();
        }
        true
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
        if page.selected.is_some() && page.selected_view() == view {
            self.pages.remove(&key);
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
                owner,
                page_id,
                choice_id,
                indexed,
                reply,
            } => {
                let result = (|| -> Result<page::MediaContext> {
                    let page = self
                        .pages
                        .values()
                        .find(|p| p.owner == owner && p.id == page_id)
                        .ok_or_else(|| anyhow!("page_player_closed"))?;
                    let selected = page
                        .selected
                        .and_then(|id| page.candidates.get(&id))
                        .ok_or_else(|| anyhow!("page_candidate_unavailable"))?;
                    let views = page.views.borrow();
                    let view = views
                        .get(&selected.view)
                        .ok_or_else(|| anyhow!("page_player_closed"))?;
                    view.media
                        .borrow_mut()
                        .sources(selected.frame, &selected.source.resource);
                    let choice = view
                        .media
                        .borrow()
                        .choice(choice_id, indexed)
                        .ok_or_else(|| anyhow!("watch_resource_unavailable"))?;
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
                    let retired = view.media.borrow().retired.subscribe();
                    Ok(page::MediaContext {
                        url: choice.source_url().to_owned(),
                        request: choice.request,
                        format: choice.format,
                        size: choice.size,
                        retired,
                        cookies,
                    })
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
                self.pages.retain(|_, page| page.owner != owner);
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
            | Operation::PageRead { page_id }
            | Operation::PagePatch { page_id, .. }
            | Operation::PageFocus { page_id }
            | Operation::PageHide { page_id }
            | Operation::PageClose { page_id }
            | Operation::PageMediaSources { page_id } => *page_id,
            _ => unreachable!(),
        };
        let key = self
            .pages
            .iter()
            .find(|(_, page)| page.owner == owner && page.id == id)
            .map(|(key, _)| *key);
        if matches!(operation, Operation::PageClose { .. }) {
            if let Some(key) = key {
                self.pages.remove(&key);
            }
            let _ = reply.send(Ok(Value::Null));
            return;
        }
        let Some(page) = key.and_then(|key| self.pages.get_mut(&key)) else {
            let _ = reply.send(Err("page_player_closed".into()));
            return;
        };
        match operation {
            Operation::PageMediaSources { .. } => {
                let result = page
                    .selected
                    .and_then(|id| page.candidates.get(&id))
                    .map(|c| {
                        page.views.borrow()[&c.view]
                            .media
                            .borrow_mut()
                            .sources(c.frame, &c.source.resource)
                    })
                    .ok_or_else(|| "page_candidate_unavailable".into());
                let _ = reply.send(result);
            }
            Operation::PageSelect { candidate_id, .. } => {
                if !page.candidates.contains_key(&candidate_id) {
                    let _ = reply.send(Err("page_candidate_unavailable".into()));
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
                        .reset();
                }
                page.selected = Some(candidate_id);
                page.candidates();
                page.request(true, None, reply);
            }
            Operation::PageRead { .. } => page.request(false, None, reply),
            Operation::PagePatch { patch, .. } => page.request(false, Some(patch), reply),
            Operation::PageHide { .. } => {
                let views = page.views.borrow();
                let view = page
                    .selected
                    .and_then(|id| page.candidates.get(&id))
                    .and_then(|candidate| views.get(&candidate.view))
                    .filter(|view| view.document.is_some());
                let result = view
                    .ok_or_else(|| "page_candidate_unavailable".to_owned())
                    .map(|view| {
                        view.window.set_visible(false);
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
        if self.pages.len() >= 64 {
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
            views,
            owner,
            origin: outgoing.origin.clone(),
            id,
            events: outgoing,
            candidates: BTreeMap::new(),
            selected: None,
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
                {
                    self.pages.remove(&key);
                } else {
                    page.candidates();
                }
            }
            PageEvent::Candidates {
                candidates,
                removed,
            } => {
                if candidates.len() > 64 || removed.len() > 64 {
                    return;
                }
                if !update_candidates(
                    &mut page.candidates,
                    page.selected,
                    view_key,
                    message.frame,
                    &message.ancestors,
                    candidates,
                    &removed,
                ) {
                    self.pages.remove(&key);
                    return;
                }
                page.candidates();
            }
            PageEvent::Sample {
                media,
                resource,
                event,
            } => {
                if page
                    .selected
                    .and_then(|id| page.candidates.get(&id))
                    .is_some_and(|c| {
                        c.view == view_key
                            && c.frame == message.frame
                            && c.source.media == media
                            && !c.source.resource.is_empty()
                            && c.source.resource != resource
                    })
                {
                    self.pages.remove(&key);
                    return;
                }
                if page
                    .selected
                    .and_then(|id| page.candidates.get(&id))
                    .is_some_and(|c| {
                        c.view == view_key && c.frame == message.frame && c.source.media == media
                    })
                {
                    page.emit(json!({"type":"page_sample","pageId":page.id,"event":event}));
                }
            }
            PageEvent::Blocked { media } => {
                if page
                    .selected
                    .and_then(|id| page.candidates.get(&id))
                    .is_some_and(|c| {
                        c.view == view_key && c.frame == message.frame && c.source.media == media
                    })
                {
                    page.emit(json!({"type":"page_blocked","pageId":page.id}));
                }
            }
            PageEvent::Reply {
                request,
                state,
                error,
            } => {
                if !page.pending.get(&request).is_some_and(|pending| {
                    pending.view == view_key && pending.frame == message.frame
                }) {
                    return;
                }
                let pending = page.pending.remove(&request).unwrap();
                let result = if let Some(error) = error {
                    Err(anyhow!(if error == "watch_autoplay_blocked" {
                        "watch_autoplay_blocked"
                    } else {
                        "watch_media_failed"
                    }))
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
                if result.is_err() && pending.selecting {
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
    if selected.is_some_and(|id| !current.contains_key(&id)) {
        return false;
    }
    for mut source in candidates {
        source.title = source.title.chars().take(256).collect();
        if source.url.as_ref().is_some_and(|url| !page::valid_url(url)) {
            source.url = None;
        }
        if source.duration.is_some_and(|v| !v.is_finite() || v < 0.) {
            source.duration = None;
        }
        if source.resource.len() > 4096 {
            continue;
        }
        let previous = current.iter().find(|(_, candidate)| {
            candidate.view == view_key
                && candidate.frame == frame
                && candidate.source.media == source.media
        });
        if previous.is_some_and(|(id, old)| {
            selected == Some(*id)
                && !old.source.resource.is_empty()
                && old.source.resource != source.resource
        }) {
            return false;
        }
        let id = match previous {
            Some((id, _)) => *id,
            None if current.len() < 64 => Uuid::new_v4(),
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

    true
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
        .with_navigation_handler(|url| page::valid_url(&url))
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
                if !page::valid_url(&uri) || pending.borrow().len() >= MAX_PENDING_POPUPS {
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
    }
    Ok(PageView {
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

#[cfg(test)]
#[tokio::test]
#[ignore = "opens a WebView2 window on an interactive Windows desktop"]
async fn cancelled_prepare_and_queued_close_release_native_windows() {
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
    use webview2_com::{
        BrowserProcessExitedEventHandler,
        Microsoft::Web::WebView2::Win32::ICoreWebView2Environment5,
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
    let (outgoing, mut events) = mpsc::channel(8);
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

    let mut retry = Box::pin(connection.request(prepare));
    assert!(futures_util::poll!(&mut retry).is_pending());
    pages.operation(commands.try_recv().unwrap(), &target, target.create_proxy());
    assert_eq!(retry.await.unwrap()["pageId"], json!(page_id));
    assert_eq!(pages.pages.len(), 1);
    let reopened = pages.pages.values().next().unwrap();
    windows.insert(reopened.views.borrow()[&reopened.root].window.id());
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

    let mut close = Box::pin(connection.request(Operation::PageClose { page_id }));
    assert!(futures_util::poll!(&mut close).is_pending());
    assert_eq!(close.await.unwrap_err().to_string(), "page_player_timeout");
    pages.operation(commands.try_recv().unwrap(), &target, target.create_proxy());
    assert!(pages.pages.is_empty());
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
    assert!(
        windows.is_empty(),
        "Tao did not destroy both native windows"
    );
    assert!(
        browser_exited.get(),
        "WebView2 still owns the temporary profile"
    );
    drop(environment);
    profile.close().unwrap();
}

#[cfg(test)]
mod candidate_tests {
    use super::*;
    fn report(media: Uuid, url: &str) -> ReportedCandidate {
        ReportedCandidate {
            media,
            resource: url.into(),
            title: "Owned video".into(),
            url: Some(url.into()),
            duration: Some(30.),
        }
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
        assert!(!candidates.contains_key(&selected)); // false takes the existing Page drop/reader-retirement path.
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
