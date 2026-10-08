//! Per-cluster kubectl (like Lens): download the kubectl release matching the
//! cluster's server version into the app data dir, verified against dl.k8s.io's
//! published SHA-256, and put it first on PATH in that cluster's terminals.

use std::path::{Path, PathBuf};
use std::time::Duration;

use futures::StreamExt;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;

use crate::state::{err, Result};
use crate::strings;

/// "v1.34.1+k3s1" / "v1.29.4-eks-036c24b" -> "v1.34.1"
pub fn normalize_version(git_version: &str) -> Option<String> {
    let v = git_version.trim().trim_start_matches('v');
    let core: String = v
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let parts: Vec<&str> = core.split('.').filter(|p| !p.is_empty()).collect();
    (parts.len() == 3).then(|| format!("v{}", parts.join(".")))
}

fn platform() -> Option<(&'static str, &'static str, &'static str)> {
    let os = match std::env::consts::OS {
        "linux" => "linux",
        "macos" => "darwin",
        "windows" => "windows",
        _ => return None,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        _ => return None,
    };
    Some((
        os,
        arch,
        if os == "windows" {
            "kubectl.exe"
        } else {
            "kubectl"
        },
    ))
}

pub fn binary_path(app: &AppHandle, version: &str) -> Result<PathBuf> {
    let (_, _, file) = platform().ok_or(strings::KUBECTL_UNSUPPORTED_PLATFORM)?;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(err)?
        .join("bin")
        .join(format!("kubectl-{version}"))
        .join(file))
}

/// Return the cached kubectl for `version`, downloading and verifying it if needed.
pub async fn ensure(app: &AppHandle, version: &str, progress: impl Fn(&str)) -> Result<PathBuf> {
    let path = binary_path(app, version)?;
    if path.exists() {
        return Ok(path);
    }
    let (os, arch, file) = platform().ok_or(strings::KUBECTL_UNSUPPORTED_PLATFORM)?;
    let url = format!("https://dl.k8s.io/release/{version}/bin/{os}/{arch}/{file}");
    progress(&strings::downloading_kubectl(version));
    // A stalled download would otherwise leave the terminal waiting forever.
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(err)?;
    let expected = http
        .get(format!("{url}.sha256"))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(strings::kubectl_checksum_error)?
        .text()
        .await
        .map_err(err)?;
    let expected = expected
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_lowercase();

    let dir = path.parent().ok_or(strings::KUBECTL_BAD_PATH)?;
    tokio::fs::create_dir_all(dir).await.map_err(err)?;
    // Unique per download: two terminals fetching the same version mustn't share a partial file.
    let tmp = dir.join(format!("{file}.{}.download", uuid::Uuid::new_v4().simple()));
    let result = download(&http, &url, &tmp, &expected, &progress)
        .await
        .and_then(|_| make_executable(&tmp));
    if let Err(e) = result {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    if let Err(e) = tokio::fs::rename(&tmp, &path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        // Another download of the same version got there first.
        if !path.exists() {
            return Err(err(e));
        }
    }
    Ok(path)
}

async fn download(
    http: &reqwest::Client,
    url: &str,
    tmp: &Path,
    expected: &str,
    progress: &impl Fn(&str),
) -> Result<()> {
    let resp = http
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(strings::kubectl_download_error)?;
    let total = resp.content_length();
    let mut out = tokio::fs::File::create(tmp).await.map_err(err)?;
    let mut hasher = Sha256::new();
    let mut stream = resp.bytes_stream();
    let mut got: u64 = 0;
    let mut last_pct = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(err)?;
        hasher.update(&chunk);
        out.write_all(&chunk).await.map_err(err)?;
        got += chunk.len() as u64;
        if let Some(t) = total {
            let pct = (got * 100 / t.max(1)) as u32;
            if pct >= last_pct + 20 {
                last_pct = pct;
                progress(&strings::download_progress(pct));
            }
        }
    }
    out.flush().await.map_err(err)?;
    drop(out);
    let actual = hex::encode(hasher.finalize());
    if actual != expected {
        return Err(strings::kubectl_checksum_mismatch(expected, &actual));
    }
    Ok(())
}

fn make_executable(p: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).map_err(err)?;
    }
    let _ = p;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::normalize_version as n;
    #[test]
    fn versions() {
        assert_eq!(n("v1.34.1+k3s1").as_deref(), Some("v1.34.1"));
        assert_eq!(n("v1.29.4-eks-036c24b").as_deref(), Some("v1.29.4"));
        assert_eq!(n("1.30.0").as_deref(), Some("v1.30.0"));
        assert_eq!(n("v1.30"), None);
    }
}
