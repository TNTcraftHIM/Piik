#![cfg(unix)]

use futures_util::FutureExt;

struct RestoreHangup(libc::sigaction);

impl Drop for RestoreHangup {
    fn drop(&mut self) {
        // SAFETY: restore this test process's original disposition, including on panic.
        unsafe { libc::sigaction(libc::SIGHUP, &self.0, std::ptr::null_mut()) };
    }
}

#[tokio::test]
async fn termination_is_registered_before_the_shutdown_future_is_polled() {
    // One serial case: the ignored phase must precede Tokio's cached HUP registration.
    let mut original = std::mem::MaybeUninit::<libc::sigaction>::uninit();
    assert_eq!(
        unsafe { libc::sigaction(libc::SIGHUP, std::ptr::null(), original.as_mut_ptr()) },
        0
    );
    // SAFETY: the successful query initialized the saved disposition.
    let _restore = RestoreHangup(unsafe { original.assume_init() });
    assert_ne!(
        unsafe { libc::signal(libc::SIGHUP, libc::SIG_IGN) },
        libc::SIG_ERR
    );
    let stop = piik_channel_native::shutdown_signal().unwrap();
    let mut action = std::mem::MaybeUninit::<libc::sigaction>::uninit();
    assert_eq!(
        unsafe { libc::sigaction(libc::SIGHUP, std::ptr::null(), action.as_mut_ptr()) },
        0
    );
    // SAFETY: the successful query initialized the current disposition.
    assert_eq!(unsafe { action.assume_init() }.sa_sigaction, libc::SIG_IGN);
    let sent = std::process::Command::new("kill")
        .args(["-HUP", &std::process::id().to_string()])
        .status()
        .unwrap();
    assert!(sent.success());
    assert!(
        stop.now_or_never().is_none(),
        "inherited SIGHUP ignore must not trigger hosting shutdown"
    );
    assert_ne!(
        unsafe { libc::signal(libc::SIGHUP, libc::SIG_DFL) },
        libc::SIG_ERR
    );

    for signal in ["-TERM", "-HUP"] {
        let stop = piik_channel_native::shutdown_signal().unwrap();
        // The entry point registers first, then opens its resources before awaiting stop.
        let sent = std::process::Command::new("kill")
            .args([signal, &std::process::id().to_string()])
            .status()
            .unwrap();
        assert!(sent.success());
        tokio::time::timeout(std::time::Duration::from_secs(2), stop)
            .await
            .unwrap_or_else(|_| panic!("{signal} must enter the normal hosting shutdown path"));
    }
}
