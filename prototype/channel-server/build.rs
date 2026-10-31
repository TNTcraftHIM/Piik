fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("x86_64")
    {
        let icon = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../cmd/piik-app/piik_windows_amd64.syso");
        println!("cargo:rerun-if-changed={}", icon.display());
        println!(
            "cargo:rustc-link-arg-bin=piik-channel-app={}",
            icon.display()
        );
    }
}
