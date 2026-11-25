use std::time::Duration;
use tokio::process::Command;

#[tokio::test]
async fn old_compose_environment_stops_before_initialization() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let mut command = Command::new(env!("CARGO_BIN_EXE_piik-channel-prototype"));
    command
        .kill_on_drop(true)
        .env("PIIK_ENV", "production")
        .env("PIIK_CHANNEL_DATA_DIR", &data)
        .env("PIIK_CHANNEL_BIND_ADDRESS", "127.0.0.1")
        .env("PIIK_CHANNEL_PORT", "0");
    let result = tokio::time::timeout(Duration::from_secs(10), command.output())
        .await
        .expect("legacy configuration must stop before service startup")
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("Detected Piik 2.x configuration"));
    assert!(!data.exists());
}
