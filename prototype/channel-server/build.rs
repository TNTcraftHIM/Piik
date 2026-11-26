fn main() {
    println!("cargo:rerun-if-env-changed=PIIK_BUILD_VERSION");
    println!("cargo:rerun-if-env-changed=PIIK_BUILD_REVISION");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("x86_64")
        && std::env::var_os("CARGO_FEATURE_CAPTURE").is_some()
    {
        let icon = std::path::PathBuf::from(
            std::env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"),
        )
        .join("../../cmd/piik-app/piik.ico");
        println!("cargo:rerun-if-changed={}", icon.display());
        version_resource(&icon);
    }
}

#[cfg(windows)]
fn version_resource(icon: &std::path::Path) {
    use std::{env, fs, path::PathBuf, process::Command};

    let version = env::var("PIIK_BUILD_VERSION").unwrap_or_else(|_| "development".into());
    let revision = env::var("PIIK_BUILD_REVISION").unwrap_or_else(|_| "development".into());
    assert!(
        revision == "development"
            || revision.len() == 40 && revision.bytes().all(|b| b.is_ascii_hexdigit()),
        "PIIK_BUILD_REVISION must be a full SHA or development"
    );
    let parsed = (version != "development").then(|| {
        semver::Version::parse(
            version
                .strip_prefix('v')
                .expect("Product version must begin with v"),
        )
        .expect("Invalid product version")
    });
    let numeric = match &parsed {
        Some(v) => [v.major, v.minor, v.patch, 0]
            .map(|part| u16::try_from(part).expect("Windows version field exceeds 65535")),
        None => [0; 4],
    };
    let flags = if parsed.as_ref().is_none_or(|v| !v.pre.is_empty()) {
        2
    } else {
        0
    };
    let [major, minor, patch, build] = numeric;
    let icon = icon
        .to_str()
        .expect("Icon path must be UTF-8")
        .replace('\\', "/");
    let directory = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let source = directory.join("piik-version.rc");
    let resource = directory.join("piik-version.res");
    fs::write(
        &source,
        format!(
            r#"
1 ICON "{icon}"
1 VERSIONINFO
FILEVERSION {major},{minor},{patch},{build}
PRODUCTVERSION {major},{minor},{patch},{build}
FILEFLAGSMASK 0x3f
FILEFLAGS {flags}
FILEOS 0x40004
FILETYPE 1
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904b0"
    BEGIN
      VALUE "FileDescription", "Piik App\0"
      VALUE "FileVersion", "{version}\0"
      VALUE "ProductName", "Piik\0"
      VALUE "ProductVersion", "{version}\0"
      VALUE "InternalName", "piik-app\0"
      VALUE "OriginalFilename", "piik-app.exe\0"
      VALUE "Comments", "Source revision: {revision}\0"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x0409, 1200
  END
END
"#
        ),
    )
    .expect("Write Windows version resource");
    let sdk = find_msvc_tools::find_windows_sdk("x86_64").expect("Windows SDK resource compiler");
    let compiler = sdk
        .path()
        .map(|path| path.join("rc.exe"))
        .find(|path| path.is_file())
        .expect("Windows SDK rc.exe");
    let status = Command::new(compiler)
        .arg("/nologo")
        .arg("/c65001")
        .arg("/fo")
        .arg(&resource)
        .arg(&source)
        .status()
        .expect("Run Windows resource compiler");
    assert!(status.success(), "Compile Windows version resource");
    println!(
        "cargo:rustc-link-arg-bin=piik-channel-app={}",
        resource.display()
    );
}

#[cfg(not(windows))]
fn version_resource(_: &std::path::Path) {
    panic!("The Windows App requires its native Windows build runner");
}
