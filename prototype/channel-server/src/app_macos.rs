//! LaunchServices owns the native Quit event; the App core owns ordered shutdown.
use anyhow::{Context, Result};
use block2::RcBlock;
use objc2::{
    define_class, msg_send,
    rc::{autoreleasepool, Allocated, Retained},
    runtime::{AnyObject, ProtocolObject},
    sel, ClassType, DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{
    NSApplication, NSApplicationDelegate, NSEvent, NSEventModifierFlags, NSEventType, NSMenu,
    NSRunningApplication,
};
use objc2_foundation::{ns_string, NSObject, NSObjectProtocol, NSOperationQueue, NSPoint};
use std::{
    cell::{OnceCell, RefCell},
    thread,
};
use tokio::sync::oneshot;

define_class!(
    // SAFETY: NSApplication is confined to the main thread. Rust ivars are
    // initialized before its designated initializer; no application Drop override.
    #[unsafe(super = NSApplication)]
    #[thread_kind = MainThreadOnly]
    #[name = "PiikChannelApplication"]
    #[ivars = RefCell<Option<oneshot::Sender<()>>>]
    struct Application;

    impl Application {
        #[unsafe(method_id(init))]
        fn init(this: Allocated<Self>) -> Retained<Self> {
            let this = this.set_ivars(RefCell::new(None));
            // SAFETY: Invoke NSApplication's designated initializer exactly once.
            unsafe { msg_send![super(this), init] }
        }

        #[unsafe(method(terminate:))]
        fn terminate(&self, _sender: Option<&AnyObject>) {
            if let Some(stop) = self.ivars().borrow_mut().take() {
                let _ = stop.send(());
            }
        }
    }
);

struct Entry {
    ready: RefCell<oneshot::Receiver<String>>,
    url: OnceCell<String>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements; all delegate calls and
    // its Rust ivars stay on the App main thread.
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    #[name = "PiikChannelAppDelegate"]
    #[ivars = Entry]
    struct Delegate;

    // SAFETY: NSObjectProtocol has no additional requirements.
    unsafe impl NSObjectProtocol for Delegate {}

    // SAFETY: NSApplicationDelegate has no additional requirements.
    unsafe impl NSApplicationDelegate for Delegate {
        #[unsafe(method(applicationShouldHandleReopen:hasVisibleWindows:))]
        fn reopen(&self, _app: &NSApplication, _has_visible_windows: bool) -> bool {
            let entry = self.ivars();
            if entry.url.get().is_none() {
                if let Ok(url) = entry.ready.borrow_mut().try_recv() {
                    let _ = entry.url.set(url);
                }
            }
            if let Some(url) = entry.url.get() {
                if let Err(error) = webbrowser::open(url) {
                    eprintln!("Open the App address in your browser: {error}");
                }
            }
            // This App has no untitled document for AppKit to create.
            false
        }
    }
);

impl Delegate {
    fn new(ready: oneshot::Receiver<String>, mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Entry {
            ready: RefCell::new(ready),
            url: OnceCell::new(),
        });
        // SAFETY: Initialize NSObject once after installing the Rust ivars.
        unsafe { msg_send![super(this), init] }
    }
}

/// Return to the main thread even when the core exits before listening or panics.
struct Completed;
impl Drop for Completed {
    fn drop(&mut self) {
        let stop = RcBlock::new(|| {
            // SAFETY: NSOperationQueue's main queue executes on the main thread.
            let mtm = unsafe { MainThreadMarker::new_unchecked() };
            let app = NSApplication::sharedApplication(mtm);
            app.stop(None);
            // stop: alone does not wake an event wait, as in SDL's Cocoa loop.
            let event = NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
                NSEventType::ApplicationDefined, NSPoint::new(0.0, 0.0),
                NSEventModifierFlags::empty(), 0.0, 0, None, 0, 0, 0,
            ).expect("ApplicationDefined wake event");
            app.postEvent_atStart(&event, true);
        });
        // SAFETY: This capture-free block is sendable; AppKit access is performed
        // only by the main queue, never by this finishing core thread.
        unsafe { NSOperationQueue::mainQueue().addOperationWithBlock(&stop) };
    }
}

pub fn run(
    core: fn(Option<oneshot::Receiver<()>>, Option<oneshot::Sender<String>>) -> Result<()>,
) -> Result<()> {
    autoreleasepool(|_| {
        // Query before creating NSApplication: direct CLI/pipes retain signal-only
        // execution. launchDate is documented as absent outside LaunchServices.
        if NSRunningApplication::currentApplication()
            .launchDate()
            .is_none()
        {
            return core(None, None);
        }
        let mtm = MainThreadMarker::new().context("AppKit requires the App main thread")?;
        // SAFETY: Create SDL-style sharedApplication through the registered subclass
        // before any base NSApplication singleton is requested, on the main thread.
        let app: Retained<Application> =
            unsafe { msg_send![Application::class(), sharedApplication] };
        let (stop, stopped) = oneshot::channel();
        *app.ivars().borrow_mut() = Some(stop);
        let (ready, entry) = oneshot::channel();
        // NSApplication holds its delegate weakly; retain it through run and join.
        let delegate = Delegate::new(entry, mtm);
        app.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));

        let menu = NSMenu::new(mtm);
        let app_menu = NSMenu::new(mtm);
        // SAFETY: terminate: is the standard NSApplication action overridden above.
        let item = unsafe {
            menu.addItemWithTitle_action_keyEquivalent(ns_string!("Piik App"), None, ns_string!(""))
        };
        item.setSubmenu(Some(&app_menu));
        unsafe {
            app_menu.addItemWithTitle_action_keyEquivalent(
                ns_string!("Quit Piik App"),
                Some(sel!(terminate:)),
                ns_string!("q"),
            );
        }
        app.setMainMenu(Some(&menu));

        let worker = thread::Builder::new()
            .name("piik-app".into())
            .spawn(move || {
                let _completed = Completed;
                core(Some(stopped), Some(ready))
            })?;
        app.run();
        match worker.join() {
            Ok(result) => result,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    })
}
