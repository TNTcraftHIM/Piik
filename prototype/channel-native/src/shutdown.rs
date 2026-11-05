use std::{future::Future, io};

/// Register process termination before the App or hosting service starts listening.
pub fn shutdown_signal() -> io::Result<impl Future<Output = ()>> {
    #[cfg(unix)]
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    #[cfg(unix)]
    let mut hangup = {
        // Preserve an inherited ignore disposition, for example from nohup.
        let mut action = std::mem::MaybeUninit::<libc::sigaction>::uninit();
        // SAFETY: a null action only queries; the output points to valid storage.
        if unsafe { libc::sigaction(libc::SIGHUP, std::ptr::null(), action.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the successful query initialized the disposition.
        let action = unsafe { action.assume_init() };
        if action.sa_sigaction == libc::SIG_IGN {
            None
        } else {
            Some(tokio::signal::unix::signal(
                tokio::signal::unix::SignalKind::hangup(),
            )?)
        }
    };
    #[cfg(windows)]
    let (mut interrupt, mut terminate, mut close) = (
        tokio::signal::windows::ctrl_c()?,
        tokio::signal::windows::ctrl_break()?,
        tokio::signal::windows::ctrl_close()?,
    );
    Ok(async move {
        #[cfg(unix)]
        tokio::select! {
            _ = interrupt.recv() => {},
            _ = terminate.recv() => {},
            _ = async {
                match hangup.as_mut() {
                    Some(signal) => { signal.recv().await; },
                    None => std::future::pending::<()>().await,
                }
            } => {},
        }
        #[cfg(windows)]
        tokio::select! {
            _ = interrupt.recv() => {},
            _ = terminate.recv() => {},
            _ = close.recv() => {},
        }
        #[cfg(not(any(unix, windows)))]
        let _ = tokio::signal::ctrl_c().await;
    })
}
