use super::{
    package::{self, Installation, Package, Prepared},
    Options, Selection,
};
use anyhow::{ensure, Context, Result};
use reqwest::{Client, Response};
use ring::digest;
use std::{
    fs::{self, File},
    io::Write,
    sync::Arc,
    time::Duration,
};

const PREFIX_BYTES: usize = 64 * 1024;
const INDEX_BYTES: usize = 256 * 1024;
const METADATA_TIMEOUT: Duration = Duration::from_secs(8);
const SOURCES: [&str; 2] = ["github", "atomgit"];

pub(super) fn client() -> Result<Client> {
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_root_certificates(rustls::RootCertStore::from_iter(
        webpki_roots::TLS_SERVER_ROOTS.iter().cloned(),
    ))
    .with_no_client_auth();
    Ok(Client::builder()
        .tls_backend_preconfigured(tls)
        .redirect(reqwest::redirect::Policy::limited(5))
        .retry(reqwest::retry::never())
        .user_agent("Piik-App-update")
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(15))
        .build()?)
}

async fn bounded(client: &Client, url: url::Url, limit: usize) -> Result<Vec<u8>> {
    let mut response = client.get(url).send().await?.error_for_status()?;
    let mut bytes = vec![];
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len() + chunk.len() <= limit,
            "Update metadata is too large"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn index(
    client: &Client,
    options: &Options,
    selection: &Selection,
) -> Result<(Vec<u8>, Vec<u8>, Package)> {
    for provider in &options.providers {
        let attempt = async {
            let (bytes, signature) = tokio::try_join!(
                bounded(
                    client,
                    provider.join(&format!("{}/update.json", selection.version))?,
                    INDEX_BYTES
                ),
                bounded(
                    client,
                    provider.join(&format!("{}/update.json.sig", selection.version))?,
                    64
                ),
            )?;
            let package = package::verify_index(
                &options.public_key,
                &bytes,
                &signature,
                selection,
                &options.target,
            )?;
            Ok::<_, anyhow::Error>((bytes, signature, package))
        };
        if let Ok(Ok(result)) = tokio::time::timeout(METADATA_TIMEOUT, attempt).await {
            return Ok(result);
        }
    }
    anyhow::bail!("No provider supplied the selected signed release")
}

async fn prefix(client: &Client, url: &url::Url, size: u64) -> Result<(Response, Vec<u8>)> {
    tokio::time::timeout(Duration::from_secs(10), read_prefix(client, url, size))
        .await
        .context("Download selection timed out")?
}

async fn read_prefix(client: &Client, url: &url::Url, size: u64) -> Result<(Response, Vec<u8>)> {
    let mut response = client.get(url.clone()).send().await?.error_for_status()?;
    let mut bytes = Vec::with_capacity(PREFIX_BYTES);
    let minimum = size.min(PREFIX_BYTES as u64) as usize;
    while bytes.len() < minimum {
        let chunk = response
            .chunk()
            .await?
            .context("Update body ended before selection")?;
        ensure!(
            bytes.len() as u64 + chunk.len() as u64 <= size,
            "Update body exceeds signed size"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok((response, bytes))
}

async fn finish(
    mut response: Response,
    prefix: Vec<u8>,
    file: &mut File,
    package: &Package,
    source: &'static str,
    progress: &impl Fn(u64, u64, &'static str),
) -> Result<()> {
    use std::io::{Seek, SeekFrom};
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    let mut received = prefix.len() as u64;
    let mut hash = digest::Context::new(&digest::SHA256);
    hash.update(&prefix);
    file.write_all(&prefix)?;
    progress(received, package.size, source);
    while let Some(chunk) = response.chunk().await? {
        received = received
            .checked_add(chunk.len() as u64)
            .context("Update body is too large")?;
        ensure!(received <= package.size, "Update body exceeds signed size");
        hash.update(&chunk);
        file.write_all(&chunk)?;
        progress(received, package.size, source);
    }
    ensure!(
        received == package.size
            && hash.finish().as_ref() == package::hex::<32>(&package.sha256).unwrap(),
        "Downloaded package does not match the signed release"
    );
    file.sync_all()?;
    Ok(())
}

pub(super) async fn prepare(
    options: &Options,
    installation: &Installation,
    operation: uuid::Uuid,
    selection: &Selection,
    progress: impl Fn(u64, u64, &'static str),
) -> Result<Prepared> {
    let client = client()?;
    let (index, signature, package) = index(&client, options, selection).await?;
    let directory = tempfile::Builder::new()
        .prefix(&format!(".piik-update-{operation}-"))
        .tempdir_in(
            installation
                .root
                .parent()
                .context("App has no installation parent")?,
        )?;
    fs::write(directory.path().join("update.json"), index)?;
    fs::write(directory.path().join("update.json.sig"), signature)?;
    let mut file = File::options()
        .write(true)
        .create_new(true)
        .open(directory.path().join("package.zip"))?;
    let urls = options
        .providers
        .each_ref()
        .map(|provider| provider.join(&format!("{}/{}", selection.version, package.artifact)));
    let urls = [urls[0].clone()?, urls[1].clone()?];
    // The losing future owns its Response. Leaving this scope cancels that body;
    // the winner returns the same Response, including every byte already read.
    let (winner, response) = {
        let first = prefix(&client, &urls[0], package.size);
        let second = prefix(&client, &urls[1], package.size);
        tokio::pin!(first, second);
        tokio::select! {
            result = &mut first => match result { Ok(response) => (0, response), Err(_) => (1, second.await?) },
            result = &mut second => match result { Ok(response) => (1, response), Err(_) => (0, first.await?) },
        }
    };
    let (response, bytes) = response;
    if finish(
        response,
        bytes,
        &mut file,
        &package,
        SOURCES[winner],
        &progress,
    )
    .await
    .is_err()
    {
        let other = 1 - winner;
        let (response, bytes) = prefix(&client, &urls[other], package.size).await?;
        finish(
            response,
            bytes,
            &mut file,
            &package,
            SOURCES[other],
            &progress,
        )
        .await?;
    }
    drop(file);
    Ok(Prepared {
        directory,
        selection: selection.clone(),
        operation,
    })
}
