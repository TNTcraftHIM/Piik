//! Server operator checks and one optional startup notice; never installs an update.
use semver::Version;
use serde::Serialize;
use serde_json::Value;
use std::{
    io::Read,
    time::{Duration, Instant},
};
use url::Url;

const GITHUB_API: &str = "https://api.github.com/repos/TNTcraftHIM/Piik/releases/latest";
const MIRROR_API: &str = "https://gitee.com/api/v5/repos/TNTcraftHIM/Piik/releases";
const GITHUB_PAGE: &str = "https://github.com/TNTcraftHIM/Piik/releases/tag/";
const MIRROR_PAGE: &str = "https://gitee.com/TNTcraftHIM/Piik/releases/tag/";
const PROVIDER_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_METADATA_BYTES: u64 = 4 << 20;

pub fn check_argument(
    arguments: impl IntoIterator<Item = String>,
) -> anyhow::Result<Option<String>> {
    let mut arguments = arguments.into_iter();
    let mut check = false;
    let mut endpoint = None;
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--check-release" if !check => check = true,
            "--api-url" if endpoint.is_none() => {
                endpoint = Some(
                    arguments
                        .next()
                        .ok_or_else(|| anyhow::anyhow!("--api-url requires an endpoint"))?,
                );
            }
            _ => anyhow::bail!("Usage: piik-server [--check-release [--api-url <endpoint>]]"),
        }
    }
    anyhow::ensure!(
        check || endpoint.is_none(),
        "--api-url requires --check-release"
    );
    Ok(check.then(|| endpoint.unwrap_or_else(|| GITHUB_API.into())))
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Status {
    UpToDate,
    UpdateAvailable,
    DifferentBuild,
    OfficialRelease,
    Unavailable,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseResult {
    status: Status,
    current_version: Option<String>,
    latest_version: Option<String>,
    current_revision: Option<String>,
    latest_revision: Option<String>,
    release_url: Option<String>,
}

impl ReleaseResult {
    pub fn exit_code(&self) -> u8 {
        match self.status {
            Status::UpToDate => 0,
            Status::UpdateAvailable | Status::DifferentBuild | Status::OfficialRelease => 10,
            Status::Unavailable => 20,
        }
    }

    fn notice(&self) -> Option<String> {
        let message = match self.status {
            Status::UpdateAvailable => {
                let major_upgrade = self
                    .current_version
                    .as_deref()
                    .and_then(version)
                    .zip(self.latest_version.as_deref().and_then(version))
                    .is_some_and(|(current, latest)| latest.major > current.major);
                if major_upgrade {
                    "WARN A new major Piik release is available; review breaking changes in the release notes before upgrading"
                } else {
                    "A newer Piik release is available"
                }
            }
            Status::DifferentBuild => "This Piik build differs from the official release",
            Status::OfficialRelease => "An official Piik release is available",
            _ => return None,
        };
        Some(format!(
            "{message} currentVersion={} latestVersion={} releaseUrl={}",
            self.current_version.as_deref().unwrap_or("development"),
            self.latest_version.as_deref()?,
            self.release_url.as_deref()?
        ))
    }
}

fn build_version() -> &'static str {
    option_env!("PIIK_BUILD_VERSION").unwrap_or("development")
}

pub fn check_build(endpoint: &str) -> ReleaseResult {
    check(
        build_version(),
        option_env!("PIIK_BUILD_REVISION").unwrap_or("development"),
        endpoint,
        (endpoint == GITHUB_API).then_some(MIRROR_API),
        &std::env::var("GITHUB_TOKEN").unwrap_or_default(),
    )
}

pub fn startup_notice() {
    if version(build_version()).is_none() {
        return;
    }
    // One process-owned thread keeps blocking HTTP/DNS off startup and Tokio's
    // shutdown path. Process exit retires it; there is no periodic checker.
    let _ = std::thread::Builder::new()
        .name("piik-release-check".into())
        .spawn(|| {
            if let Some(notice) = check_build(GITHUB_API).notice() {
                eprintln!("{notice}");
            }
        });
}

struct PublishedRelease {
    version: Version,
    revision: Option<String>,
    url: String,
}

fn version(value: &str) -> Option<Version> {
    Version::parse(value.trim().strip_prefix('v')?).ok()
}

fn revision(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    (value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(value)
}

fn published(value: &Value, mirror: bool) -> Option<PublishedRelease> {
    let tag = value.get("tag_name")?.as_str()?;
    let version = version(tag)?;
    if tag != format!("v{version}") || !version.pre.is_empty() || !version.build.is_empty() {
        return None;
    }
    if mirror {
        if value.get("prerelease")? != false {
            return None;
        }
        let mut sources = value.get("body")?.as_str()?.lines().filter_map(|line| {
            let sha = line
                .strip_prefix("<!-- piik-source: ")?
                .strip_suffix(" -->")?;
            (sha.len() == 40
                && sha
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
            .then_some(sha)
        });
        let source = sources.next()?;
        if sources.next().is_some() {
            return None;
        }
        Some(PublishedRelease {
            version,
            revision: Some(source.into()),
            url: format!("{MIRROR_PAGE}{tag}"),
        })
    } else {
        if value.get("draft").is_some_and(|value| value != false)
            || value.get("prerelease").is_some_and(|value| value != false)
            || value.get("html_url")?.as_str()? != format!("{GITHUB_PAGE}{tag}")
        {
            return None;
        }
        Some(PublishedRelease {
            version,
            revision: value
                .get("target_commitish")
                .and_then(Value::as_str)
                .and_then(revision),
            url: format!("{GITHUB_PAGE}{tag}"),
        })
    }
}

fn check(
    current_version: &str,
    current_revision: &str,
    endpoint: &str,
    mirror: Option<&str>,
    token: &str,
) -> ReleaseResult {
    let current = version(current_version);
    let mut result = ReleaseResult {
        status: Status::Unavailable,
        current_version: (!current_version.trim().is_empty()).then(|| {
            current
                .as_ref()
                .map(|version| format!("v{version}"))
                .unwrap_or_else(|| current_version.trim().into())
        }),
        current_revision: revision(current_revision),
        latest_version: None,
        latest_revision: None,
        release_url: None,
    };
    if current.is_none() && result.current_revision.is_none() {
        return result;
    }
    let agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .user_agent("Piik-release-check")
        .timeout_global(Some(PROVIDER_TIMEOUT))
        .build()
        .new_agent();
    let latest =
        latest(&agent, endpoint, token, false).or_else(|| latest(&agent, mirror?, "", true));
    let Some(latest) = latest else {
        return result;
    };
    result.status = match current {
        Some(current) => match latest.version.cmp_precedence(&current) {
            std::cmp::Ordering::Greater => Status::UpdateAvailable,
            std::cmp::Ordering::Equal
                if result.current_revision.is_some()
                    && latest.revision.is_some()
                    && result.current_revision != latest.revision =>
            {
                Status::DifferentBuild
            }
            _ => Status::UpToDate,
        },
        None => match (&result.current_revision, &latest.revision) {
            (Some(current), Some(latest)) if current == latest => Status::UpToDate,
            (Some(_), Some(_)) => Status::OfficialRelease,
            _ => Status::Unavailable,
        },
    };
    result.latest_version = Some(format!("v{}", latest.version));
    result.latest_revision = latest.revision;
    result.release_url = Some(latest.url);
    result
}

fn latest(
    agent: &ureq::Agent,
    endpoint: &str,
    token: &str,
    mirror: bool,
) -> Option<PublishedRelease> {
    let mut endpoint = Url::parse(endpoint).ok()?;
    if !matches!(endpoint.scheme(), "http" | "https") {
        return None;
    }
    let deadline = Instant::now() + PROVIDER_TIMEOUT;
    let mut latest: Option<PublishedRelease> = None;
    for page in 1..=10 {
        if mirror {
            endpoint
                .query_pairs_mut()
                .clear()
                .append_pair("per_page", "100")
                .append_pair("page", &page.to_string())
                .append_pair("direction", "desc");
        }
        let mut request = agent.get(endpoint.as_str()).header(
            "Accept",
            if mirror {
                "application/json"
            } else {
                "application/vnd.github+json"
            },
        );
        if !mirror {
            request = request.header("X-GitHub-Api-Version", "2022-11-28");
            if endpoint.scheme() == "https"
                && endpoint.host_str() == Some("api.github.com")
                && !token.trim().is_empty()
            {
                request = request.header("Authorization", format!("Bearer {}", token.trim()));
            }
        }
        let remaining = deadline.checked_duration_since(Instant::now())?;
        let mut response = request
            .config()
            .timeout_global(Some(remaining))
            .build()
            .call()
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let mut body = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take(MAX_METADATA_BYTES + 1)
            .read_to_end(&mut body)
            .ok()?;
        if body.len() as u64 > MAX_METADATA_BYTES {
            return None;
        }
        let data: Value = serde_json::from_slice(&body).ok()?;
        if !mirror {
            return published(&data, false);
        }
        let releases = data.as_array().filter(|values| values.len() <= 100)?;
        for candidate in releases.iter().filter_map(|value| published(value, true)) {
            if latest
                .as_ref()
                .is_none_or(|latest| candidate.version > latest.version)
            {
                latest = Some(candidate);
            }
        }
        if releases.len() < 100 {
            return latest;
        }
    }
    None // A truncated mirror listing cannot establish the highest stable release.
}

#[cfg(test)]
#[path = "release_tests.rs"]
mod tests;
