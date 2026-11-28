use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=PIIK_BUILD_VERSION");
    println!("cargo:rerun-if-changed=development-version.json");
    let version = env::var("PIIK_BUILD_VERSION").unwrap_or_else(|_| "development".into());
    let (major, minor) = if version == "development" {
        let target: serde_json::Value =
            serde_json::from_str(include_str!("development-version.json"))
                .expect("Invalid development version");
        (
            target["major"].as_u64().unwrap(),
            target["minor"].as_u64().unwrap(),
        )
    } else {
        let parsed = semver::Version::parse(
            version
                .strip_prefix('v')
                .expect("Build version must start with v"),
        )
        .expect("Invalid build version");
        assert!(
            parsed.build.is_empty(),
            "Build version cannot contain build metadata"
        );
        (parsed.major, parsed.minor)
    };
    let major = u32::try_from(major).expect("Product major exceeds u32");
    let minor = u32::try_from(minor).expect("Product minor exceeds u32");
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("product_version.rs");
    fs::write(
        output,
        format!("ProductVersion {{ major: {major}, minor: {minor} }}"),
    )
    .unwrap();
}
