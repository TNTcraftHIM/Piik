#![cfg(unix)]

#[tokio::test]
async fn termination_is_registered_before_the_shutdown_future_is_polled() {
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
