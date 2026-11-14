//! Response facts are intersected with the selected frame's observed resources.
use crate::app::page::{self, Format};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
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
    pub id: Uuid,
    pub url: String,
    pub format: Format,
    pub size: Option<u64>,
}
pub struct Media {
    observed: BTreeMap<String, (Format, Option<u64>)>,
    redirects: BTreeMap<String, String>,
    frames: BTreeMap<Uuid, BTreeSet<String>>,
    choices: BTreeMap<Uuid, Choice>,
    pub retired: watch::Sender<bool>,
}
impl Default for Media {
    fn default() -> Self {
        Self {
            observed: BTreeMap::new(),
            redirects: BTreeMap::new(),
            frames: BTreeMap::new(),
            choices: BTreeMap::new(),
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
    pub fn frame(&mut self, id: Uuid, urls: Vec<String>) {
        if self.frames.len() < 64 || self.frames.contains_key(&id) {
            self.frames.insert(
                id,
                urls.into_iter()
                    .filter(|v| page::valid_url(v))
                    .take(128)
                    .collect(),
            );
        }
    }
    fn response<'a>(&'a self, mut url: &'a str) -> Option<(Format, Option<u64>)> {
        // Join observed response facts; HTTP redirects themselves remain owned by reqwest.
        for _ in 0..=10 {
            if let Some(fact) = self.observed.get(url) {
                return Some(*fact);
            }
            url = self.redirects.get(url)?;
        }
        None
    }
    pub fn sources(&mut self, frame: Uuid, current: &str) -> Value {
        let mut found = vec![];
        if let Some((format, size)) = self.response(current) {
            if format == Format::Hls || size.is_some() {
                found.push((current.to_owned(), format, size));
            }
        }
        if let Some(urls) = self.frames.get(&frame) {
            for url in urls {
                if let Some((Format::Hls, size)) = self.response(url) {
                    if !found.iter().any(|(existing, _, _)| existing == url) {
                        found.push((url.clone(), Format::Hls, size));
                    }
                }
            }
        }
        self.choices
            .retain(|_, choice| found.iter().any(|(url, _, _)| *url == choice.url));
        for (url, format, size) in found.into_iter().take(32) {
            if !self.choices.values().any(|c| c.url == url) {
                let id = Uuid::new_v4();
                self.choices.insert(
                    id,
                    Choice {
                        id,
                        url,
                        format,
                        size,
                    },
                );
            }
        }
        json!({"choices":self.choices.values().map(|c|json!({"id":c.id,"displayURL":c.url,"name":url::Url::parse(&c.url).ok().map(|u|u.path().rsplit('/').next().unwrap_or("Video").chars().take(256).collect::<String>()).unwrap_or_else(||"Video".into()),"format":c.format})).collect::<Vec<_>>()})
    }
    pub fn choice(&self, id: Uuid) -> Option<Choice> {
        self.choices.get(&id).cloned()
    }
}
pub fn observe(view: &WebView, media: Rc<RefCell<Media>>) -> Result<()> {
    unsafe {
        view.webview()
            .cast::<ICoreWebView2_2>()?
            .add_WebResourceResponseReceived(
                &WebResourceResponseReceivedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut uri = PWSTR::null();
                    args.Request()?.Uri(&mut uri)?;
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
                            if media.redirects.len() < 128 || media.redirects.contains_key(&uri) {
                                media.redirects.insert(uri, target.to_string());
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
                    let format = if matches!(
                        mime.as_str(),
                        "application/vnd.apple.mpegurl"
                            | "application/x-mpegurl"
                            | "audio/mpegurl"
                            | "audio/x-mpegurl"
                    ) {
                        Format::Hls
                    } else if mime.starts_with("video/") || mime.starts_with("audio/") {
                        Format::File
                    } else {
                        return Ok(());
                    };
                    let size = if status == 206 {
                        header("Content-Range")
                            .and_then(|v| v.rsplit('/').next()?.parse::<u64>().ok())
                    } else {
                        header("Content-Length").and_then(|v| v.parse().ok())
                    };
                    let mut media = media.borrow_mut();
                    if media.observed.len() < 128 || media.observed.contains_key(&uri) {
                        media.observed.insert(uri, (format, size));
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
