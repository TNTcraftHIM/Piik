//! The built frontend is served alongside explicitly composed runtime routes.
use axum::Router;
use std::path::Path;
use tower_http::services::{ServeDir, ServeFile};

pub fn frontend(directory: &Path) -> anyhow::Result<Router> {
    let index = directory.join("index.html");
    anyhow::ensure!(
        index.is_file(),
        "frontend directory must contain index.html"
    );
    Ok(Router::new()
        .route_service("/", ServeFile::new(index.clone()))
        .route_service("/__channel-preview", ServeFile::new(index))
        .fallback_service(ServeDir::new(directory).append_index_html_on_directories(false)))
}
