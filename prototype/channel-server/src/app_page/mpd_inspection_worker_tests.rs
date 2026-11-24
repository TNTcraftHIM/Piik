//! Public inspection cancellation retires the parser worker before reusing its slot.
use super::*;
use piik_channel_mpd::Cancelled;
use std::sync::{Condvar, OnceLock};

#[derive(Debug)]
enum Event {
    Entered,
    Exited { cancelled: bool },
}
struct Probe {
    events: mpsc::UnboundedSender<Event>,
    checks: AtomicUsize,
    active: AtomicUsize,
    released: (Mutex<bool>, Condvar),
}
static CURRENT: OnceLock<Mutex<Option<Arc<Probe>>>> = OnceLock::new();
pub(crate) struct WorkerExit {
    probe: Option<Arc<Probe>>,
    cancelled: Cancelled,
}
impl Drop for WorkerExit {
    fn drop(&mut self) {
        if let Some(probe) = &self.probe {
            probe.active.fetch_sub(1, Ordering::SeqCst);
            // invoke has returned, after its explicit Context/Runtime drop.
            let _ = probe.events.send(Event::Exited {
                cancelled: (self.cancelled)(),
            });
        }
    }
}
pub(crate) fn observe(path: &str, cancelled: Cancelled) -> (Cancelled, WorkerExit) {
    let probe = if path == "/worker-retirement.mpd" {
        CURRENT
            .get()
            .and_then(|current| current.lock().unwrap().clone())
    } else {
        None
    };
    let exit = WorkerExit {
        probe: probe.clone(),
        cancelled: cancelled.clone(),
    };
    let Some(probe) = probe else {
        return (cancelled, exit);
    };
    probe.active.fetch_add(1, Ordering::SeqCst);
    let wrapped: Cancelled = Arc::new(move || {
        // Check 1 is invoke's pre-runtime guard; check 2 is the actual JS interrupt.
        if probe.checks.fetch_add(1, Ordering::SeqCst) == 1 {
            let _ = probe.events.send(Event::Entered);
            let (lock, wake) = &probe.released;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = wake.wait(released).unwrap();
            }
        }
        cancelled()
    });
    (wrapped, exit)
}
struct Installed(Arc<Probe>);
impl Drop for Installed {
    fn drop(&mut self) {
        // Test failure cannot strand a blocking interpreter at the observation gate.
        *self.0.released.0.lock().unwrap() = true;
        self.0.released.1.notify_all();
        *CURRENT.get().unwrap().lock().unwrap() = None;
    }
}

#[tokio::test]
async fn public_inspect_cancel_retires_actual_parser_worker_twice_before_reusing_slot() -> Result<()>
{
    let _ = rustls::crypto::ring::default_provider().install_default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let router = Router::new().route("/worker-retirement.mpd", get(|| async { CLEAR_MPD }));
    let (shutdown, stopped) = oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let page = Uuid::new_v4();
    let (_page_lifetime, retired) = watch::channel(false);
    let (events, _) = mpsc::channel(8);
    let connection = Arc::new(Connection::new(
        Some(Arc::new(move |command| {
            match command {
                Command::Media { reply, .. } => {
                    let _ = reply.send(Ok((MediaContext {
                        url: format!("{origin}/worker-retirement.mpd"),
                        request: None,
                        format: Format::Dash,
                        size: None,
                        retired: retired.clone(),
                        cookies: Arc::new(|_| Box::pin(async { Ok(None) })),
                    }, Default::default())));
                }
                Command::Retire { .. } => {}
                _ => panic!("unexpected command"),
            }
            true
        })),
        events,
    ));
    let (send, mut receive) = mpsc::unbounded_channel();
    let probe = Arc::new(Probe {
        events: send,
        checks: AtomicUsize::new(0),
        active: AtomicUsize::new(0),
        released: (Mutex::new(false), Condvar::new()),
    });
    assert!(CURRENT
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap()
        .replace(probe.clone())
        .is_none());
    let installed = Installed(probe.clone());
    for _ in 0..2 {
        probe.checks.store(0, Ordering::SeqCst);
        *probe.released.0.lock().unwrap() = false;
        let id = Uuid::new_v4();
        let waiting = tokio::spawn(connection.inspect_mpd(page, None, Uuid::new_v4(), id)?);
        // Existing fixture deadline bounds an observation, not product cancellation.
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), receive.recv()).await?,
            Some(Event::Entered)
        ));
        assert_eq!(probe.active.load(Ordering::SeqCst), 1);
        connection.cancel_resource(page, id);
        assert_eq!(
            waiting.await?.err().unwrap().to_string(),
            "watch_read_cancelled"
        );
        assert_eq!(connection.media_reads.available_permits(), MAX_MEDIA_READS);
        assert!(connection.resource_reads.lock().unwrap().is_empty());
        assert!(connection
            .media
            .lock()
            .unwrap()
            .get(&(page, None)).is_none());
        *probe.released.0.lock().unwrap() = true;
        probe.released.1.notify_all();
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), receive.recv()).await?,
            Some(Event::Exited { cancelled: true })
        ));
        assert_eq!(probe.active.load(Ordering::SeqCst), 0);
    }
    drop(installed);
    let next = connection
        .inspect_mpd(page, None, Uuid::new_v4(), Uuid::new_v4())?
        .await?;
    assert!(!next["tracks"].as_array().unwrap().is_empty());
    assert_eq!(probe.active.load(Ordering::SeqCst), 0);
    connection.stop_media(page);
    drop(connection);
    let _ = shutdown.send(());
    server.await?;
    Ok(())
}
