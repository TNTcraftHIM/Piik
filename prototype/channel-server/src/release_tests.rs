use super::*;
use axum::{
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

const SOURCE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const LOCAL: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

struct Fixture {
    url: String,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn fixture(routes: Router) -> Fixture {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, routes).await.unwrap();
    });
    Fixture { url, task }
}

fn github() -> Value {
    json!({"tag_name":"v3.0.0", "target_commitish":SOURCE,
        "html_url":format!("{GITHUB_PAGE}v3.0.0"), "draft":false, "prerelease":false})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn operator_results_preserve_version_precedence_and_manual_build_choices() {
    let requests = Arc::new(AtomicUsize::new(0));
    let observed = requests.clone();
    let service = fixture(Router::new().route(
        "/latest",
        get(move |headers: HeaderMap| {
            observed.fetch_add(1, Ordering::SeqCst);
            async move {
                assert_eq!(headers["accept"], "application/vnd.github+json");
                assert_eq!(headers["x-github-api-version"], "2022-11-28");
                assert_eq!(headers["user-agent"], "Piik-release-check");
                assert!(!headers.contains_key("authorization"));
                Json(github())
            }
        }),
    ))
    .await;
    for (version, source, status, code) in [
        ("v2.9.0", SOURCE, Status::UpdateAvailable, 10),
        ("v3.0.0", LOCAL, Status::DifferentBuild, 10),
        ("v3.0.0", SOURCE, Status::UpToDate, 0),
        ("v4.0.0", LOCAL, Status::UpToDate, 0),
        ("development", LOCAL, Status::OfficialRelease, 10),
        ("development", SOURCE, Status::UpToDate, 0),
    ] {
        let result = check(
            version,
            source,
            &format!("{}/latest", service.url),
            None,
            "operator-token",
        );
        assert_eq!(result.status, status);
        assert_eq!(result.exit_code(), code);
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["currentVersion"], version);
        assert_eq!(json["currentRevision"], source);
        assert_eq!(json["latestVersion"], "v3.0.0");
        assert_eq!(json["releaseUrl"], format!("{GITHUB_PAGE}v3.0.0"));
        if version == "v2.9.0" {
            assert!(result.notice().unwrap().contains("review breaking changes"));
        }
        if result.status == Status::UpToDate {
            assert!(result.notice().is_none());
        }
    }
    let unknown = check("development", "development", &service.url, None, "");
    assert_eq!(unknown.exit_code(), 20);
    assert_eq!(
        serde_json::to_value(unknown).unwrap()["currentRevision"],
        Value::Null
    );
    assert_eq!(requests.load(Ordering::SeqCst), 6);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fallback_pages_share_the_published_mirror_fixture_and_keep_github_primary() {
    let pages = Arc::new(AtomicUsize::new(0));
    let observed = pages.clone();
    let service = fixture(
        Router::new()
            .route(
                "/unavailable",
                get(|| async { StatusCode::SERVICE_UNAVAILABLE }),
            )
            .route("/latest", get(|| async { Json(github()) }))
            .route(
                "/mirror",
                get(
                    move |headers: HeaderMap,
                          axum::extract::Query(query): axum::extract::Query<
                        std::collections::HashMap<String, String>,
                    >| {
                        observed.fetch_add(1, Ordering::SeqCst);
                        async move {
                            assert_eq!(headers["accept"], "application/json");
                            assert!(!headers.contains_key("authorization"));
                            assert!(!headers.contains_key("x-github-api-version"));
                            assert_eq!(query["per_page"], "100");
                            assert_eq!(query["direction"], "desc");
                            let releases: Vec<Value> = serde_json::from_str(include_str!(
                                "../../../tests/fixtures/mirror-releases.json"
                            ))
                            .unwrap();
                            Json(if query["page"] == "1" {
                                vec![releases[0].clone(); 100]
                            } else {
                                releases
                            })
                        }
                    },
                ),
            ),
    )
    .await;
    let mirror = format!("{}/mirror", service.url);
    let result = check(
        "v1.9.0",
        LOCAL,
        &format!("{}/unavailable", service.url),
        Some(&mirror),
        "operator-token",
    );
    assert_eq!(result.status, Status::UpdateAvailable);
    assert_eq!(result.latest_version.as_deref(), Some("v1.10.0"));
    assert_eq!(result.latest_revision.as_deref(), Some(SOURCE));
    assert_eq!(
        result.release_url.as_deref(),
        Some("https://gitee.com/TNTcraftHIM/Piik/releases/tag/v1.10.0")
    );
    assert_eq!(pages.load(Ordering::SeqCst), 2);
    assert!(!result.notice().unwrap().contains("major"));
    let current = check(
        "v3.0.0",
        SOURCE,
        &format!("{}/latest", service.url),
        Some(&mirror),
        "",
    );
    assert_eq!(current.status, Status::UpToDate);
    assert_eq!(
        pages.load(Ordering::SeqCst),
        2,
        "A usable primary must not consult the mirror"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unavailable_checks_bound_response_size_and_time_without_following_redirects() {
    let redirected = Arc::new(AtomicUsize::new(0));
    let observed = redirected.clone();
    let service = fixture(
        Router::new()
            .route(
                "/redirect",
                get(|| async { axum::response::Redirect::temporary("/destination") }),
            )
            .route(
                "/destination",
                get(move || {
                    observed.fetch_add(1, Ordering::SeqCst);
                    async { Json(github()) }
                }),
            )
            .route(
                "/large",
                get(|| async { vec![b' '; MAX_METADATA_BYTES as usize + 1] }),
            )
            .route(
                "/slow",
                get(|| async {
                    tokio::time::sleep(PROVIDER_TIMEOUT * 2).await;
                    Json(github())
                }),
            ),
    )
    .await;
    for path in ["/redirect", "/large", "/slow"] {
        let started = Instant::now();
        let result = check(
            "v2.0.0",
            LOCAL,
            &format!("{}{path}", service.url),
            None,
            "operator-token",
        );
        assert_eq!(result.status, Status::Unavailable);
        assert_eq!(result.exit_code(), 20);
        assert!(result.notice().is_none());
        assert!(started.elapsed() < PROVIDER_TIMEOUT + Duration::from_secs(2));
    }
    assert_eq!(redirected.load(Ordering::SeqCst), 0);
    let branch = published(
        &json!({"tag_name":"v3.0.0", "target_commitish":"main",
        "html_url":format!("{GITHUB_PAGE}v3.0.0")}),
        false,
    )
    .unwrap();
    assert!(branch.revision.is_none());
    let mut preview = github();
    preview["prerelease"] = json!(true);
    assert!(published(&preview, false).is_none());
}
