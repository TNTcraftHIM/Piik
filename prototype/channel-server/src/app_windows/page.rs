#[path = "page_media.rs"]
mod media;
// UI-thread ownership for website windows. Only the App connection supplies commands.
use super::ServiceEvent;
use crate::app::page::{self, Command, MediaState, Operation};
use anyhow::{anyhow, bail, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{cell::RefCell, collections::BTreeMap, rc::Rc};
use tao::{
    dpi::LogicalSize,
    event_loop::{EventLoopProxy, EventLoopWindowTarget},
    window::{Window, WindowBuilder, WindowId},
};
use tokio::sync::oneshot;
use uuid::Uuid;
use webview2_com::{
    Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_STATE_DENY,
    PermissionRequestedEventHandler, WindowCloseRequestedEventHandler,
};
use wry::{
    NewWindowResponse, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows,
    WebViewExtWindows,
};

type Children = Rc<RefCell<Vec<(WebView, Window)>>>;
type Reply = oneshot::Sender<Result<Value, String>>;
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
    frame: Uuid,
    ancestors: Vec<Uuid>,
    source: ReportedCandidate,
}
struct Pending {
    reply: Reply,
    frame: Uuid,
    selecting: bool,
    patch: bool,
}
struct Page {
    // WebView drops before the native window.
    children: Children,
    view: WebView,
    window: Window,
    owner: Uuid,
    id: Uuid,
    events: page::Events,
    document: Option<Uuid>,
    candidates: BTreeMap<Uuid, Candidate>,
    selected: Option<Uuid>,
    media: Rc<RefCell<media::Media>>,
    pending: BTreeMap<Uuid, Pending>,
}
impl Page {
    fn emit(&self, value: Value) {
        self.events.send(value);
    }
    fn candidates(&self) {
        let Some(url) = self.view.url().ok().filter(|url| page::valid_url(url)) else {
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
            .view
            .evaluate_script(&format!("window.postMessage({command}, '*')"))
        {
            Ok(()) => {
                self.pending.insert(
                    request,
                    Pending {
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
        self.media.borrow().retired.send_replace(true);
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
    pub fn close_window(&mut self, id: WindowId) -> bool {
        let key = self
            .pages
            .iter()
            .find(|(_, page)| page.window.id() == id)
            .map(|(key, _)| *key);
        if let Some(key) = key {
            self.pages.remove(&key);
            return true;
        }
        for page in self.pages.values() {
            let mut children = page.children.borrow_mut();
            if let Some(index) = children.iter().position(|(_, window)| window.id() == id) {
                children.remove(index);
                return true;
            }
        }
        false
    }
    pub fn navigate(&mut self, key: Uuid) {
        if self
            .pages
            .get(&key)
            .is_some_and(|page| page.selected.is_some())
        {
            self.pages.remove(&key);
        } else if let Some(page) = self.pages.get_mut(&key) {
            page.media.borrow_mut().reset();
            page.document = None;
            page.candidates.clear();
            page.candidates();
        }
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
                    page.media
                        .borrow_mut()
                        .sources(selected.frame, &selected.source.resource);
                    let choice = page
                        .media
                        .borrow()
                        .choice(choice_id)
                        .ok_or_else(|| anyhow!("watch_resource_unavailable"))?;
                    let document = page.document.ok_or_else(|| anyhow!("page_player_closed"))?;
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
                    Ok(page::MediaContext {
                        url: choice.url,
                        format: choice.format,
                        size: choice.size,
                        retired: page.media.borrow().retired.subscribe(),
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
                if let Some(page) = self
                    .pages
                    .values()
                    .find(|p| p.owner == owner && p.id == page_id && p.document == Some(document))
                {
                    if page::valid_url(&url) {
                        let _ = media::cookies(
                            &page.view,
                            url,
                            page.media.borrow().retired.subscribe(),
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
        if reply.is_closed() {
            return;
        }
        if let Operation::PagePrepare { page_id, url } = operation {
            let result = self.prepare(owner, page_id, url, outgoing, target, events);
            let _ = reply.send(
                result
                    .map(|()| json!({"pageId":page_id}))
                    .map_err(|error| error.to_string()),
            );
            return;
        }
        let id = match &operation {
            Operation::PageSelect { page_id, .. }
            | Operation::PageRead { page_id }
            | Operation::PagePatch { page_id, .. }
            | Operation::PageFocus { page_id }
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
                    .map(|c| page.media.borrow_mut().sources(c.frame, &c.source.resource))
                    .ok_or_else(|| "page_candidate_unavailable".into());
                let _ = reply.send(result);
            }
            Operation::PageSelect { candidate_id, .. } => {
                if !page.candidates.contains_key(&candidate_id) {
                    let _ = reply.send(Err("page_candidate_unavailable".into()));
                    return;
                }
                if page.selected.is_some_and(|id| id != candidate_id) {
                    page.media.borrow_mut().reset();
                }
                page.selected = Some(candidate_id);
                page.candidates();
                page.request(true, None, reply);
            }
            Operation::PageRead { .. } => page.request(false, None, reply),
            Operation::PagePatch { patch, .. } => page.request(false, Some(patch), reply),
            Operation::PageFocus { .. } => {
                page.window.set_minimized(false);
                page.window.set_focus();
                let _ = page.view.focus();
                let _ = reply.send(Ok(Value::Null));
            }
            _ => unreachable!(),
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
    ) -> Result<()> {
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
        let window = WindowBuilder::new()
            .with_title("Piik · Video")
            .with_inner_size(LogicalSize::new(1000., 720.))
            .build(target)?;
        let messages = events.clone();
        let navigating = events.clone();
        let children: Children = Rc::default();
        let popup_children = children.clone();
        let popup_target = target.clone();
        let popup_events = events.clone();
        let media = Rc::new(RefCell::new(media::Media::default()));
        let view = WebViewBuilder::new_with_web_context(&mut self.context)
            .with_url("about:blank")
            .with_initialization_script_for_main_only(include_str!("page-player.js"), false)
            .with_ipc_handler(move |request| {
                if request.body().len() <= 65536 {
                    let _ =
                        messages.send_event(ServiceEvent::PageMessage(key, request.into_body()));
                }
            })
            .with_navigation_handler(move |url| {
                if !page::valid_url(&url) {
                    return false;
                }
                let _ = navigating.send_event(ServiceEvent::PageNavigate(key));
                true
            })
            .with_new_window_req_handler(move |url, features| {
                if !page::valid_url(&url) {
                    return NewWindowResponse::Deny;
                }
                let create = || -> Result<NewWindowResponse> {
                    let window = WindowBuilder::new()
                        .with_title("Piik ? Sign in")
                        .with_inner_size(LogicalSize::new(720., 760.))
                        .build(&popup_target)?;
                    let view = WebViewBuilder::new()
                        .with_environment(features.opener.environment)
                        .with_navigation_handler(|url| page::valid_url(&url))
                        .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
                        .build(&window)?;
                    website_permissions(&view)?;
                    let events = popup_events.clone();
                    let id = window.id();
                    unsafe {
                        view.webview().add_WindowCloseRequested(
                            &WindowCloseRequestedEventHandler::create(Box::new(move |_, _| {
                                let _ = events.send_event(ServiceEvent::PopupClosed(id));
                                Ok(())
                            })),
                            &mut Default::default(),
                        )?;
                    }
                    let response = NewWindowResponse::Create {
                        webview: view.webview(),
                    };
                    popup_children.borrow_mut().push((view, window));
                    Ok(response)
                };
                create().unwrap_or(NewWindowResponse::Deny)
            })
            .build(&window)?;
        media::observe(&view, media.clone())?;
        view.load_url(&url)?;
        let closed = events;
        let window_id = window.id();
        // Website browsing never inherits Piik's camera/microphone or App device grants.
        unsafe {
            website_permissions(&view)?;
            view.webview().add_WindowCloseRequested(
                &WindowCloseRequestedEventHandler::create(Box::new(move |_, _| {
                    let _ = closed.send_event(ServiceEvent::PopupClosed(window_id));
                    Ok(())
                })),
                &mut Default::default(),
            )?;
        }
        self.pages.insert(
            key,
            Page {
                children,
                view,
                window,
                owner,
                id,
                events: outgoing,
                document: None,
                candidates: BTreeMap::new(),
                selected: None,
                media,
                pending: BTreeMap::new(),
            },
        );
        Ok(())
    }
    pub fn message(&mut self, key: Uuid, body: &str) {
        let Ok(message) = serde_json::from_str::<Message>(body) else {
            return;
        };
        if message.ancestors.len() > 32 {
            return;
        }
        let Some(page) = self.pages.get_mut(&key) else {
            return;
        };
        if matches!(message.event, PageEvent::Document) {
            if message.document == message.frame && page.document.is_none() {
                page.document = Some(message.document);
            }
            return;
        }
        if page.document != Some(message.document) {
            return;
        }
        match message.event {
            PageEvent::Resources { urls } => {
                page.media.borrow_mut().frame(message.frame, urls);
            }
            PageEvent::Removed { removed } => {
                page.candidates.retain(|_, candidate| {
                    candidate.frame != removed && !candidate.ancestors.contains(&removed)
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
            PageEvent::Candidates { candidates } => {
                if candidates.len() > 64 {
                    return;
                }
                let existing = std::mem::take(&mut page.candidates);
                let mut previous = BTreeMap::new();
                for (id, candidate) in existing {
                    if candidate.frame == message.frame {
                        previous.insert(candidate.source.media, (id, candidate));
                    } else {
                        page.candidates.insert(id, candidate);
                    }
                }
                for mut source in candidates.into_iter().take(64 - page.candidates.len()) {
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
                    let previous = previous.remove(&source.media);
                    if previous.as_ref().is_some_and(|(id, old)| {
                        page.selected == Some(*id)
                            && !old.source.resource.is_empty()
                            && old.source.resource != source.resource
                    }) {
                        self.pages.remove(&key);
                        return;
                    }
                    let id = previous.map(|(id, _)| id).unwrap_or_else(Uuid::new_v4);
                    page.candidates.insert(
                        id,
                        Candidate {
                            frame: message.frame,
                            ancestors: message.ancestors.clone(),
                            source,
                        },
                    );
                }
                if page
                    .selected
                    .is_some_and(|id| !page.candidates.contains_key(&id))
                {
                    self.pages.remove(&key);
                } else {
                    page.candidates();
                }
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
                        c.frame == message.frame
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
                    .is_some_and(|c| c.frame == message.frame && c.source.media == media)
                {
                    page.emit(json!({"type":"page_sample","pageId":page.id,"event":event}));
                }
            }
            PageEvent::Blocked { media } => {
                if page
                    .selected
                    .and_then(|id| page.candidates.get(&id))
                    .is_some_and(|c| c.frame == message.frame && c.source.media == media)
                {
                    page.emit(json!({"type":"page_blocked","pageId":page.id}));
                }
            }
            PageEvent::Reply {
                request,
                state,
                error,
            } => {
                if !page
                    .pending
                    .get(&request)
                    .is_some_and(|pending| pending.frame == message.frame)
                {
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

fn website_permissions(view: &WebView) -> Result<()> {
    unsafe {
        view.webview().add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                }
                Ok(())
            })),
            &mut Default::default(),
        )?;
    }
    Ok(())
}
