//! The list of servers this device has added, and the checks an address goes through first.

use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};
use url::Url;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub id: String,
    /// The server's origin, e.g. `https://chat.example.com`.
    pub url: String,
    /// The host until the page reports the server's name.
    pub name: String,
    /// A `data:image/...` URL reported by the page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

/// Everything the shell remembers between runs (`servers.json` in the app config dir).
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    #[serde(default)]
    pub servers: Vec<Server>,
    #[serde(default)]
    pub tray_notice_shown: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddError {
    Invalid,
    Insecure,
    Duplicate,
    Unreachable,
    NotDatrope,
}

impl AddError {
    pub fn message(&self) -> &'static str {
        match self {
            AddError::Invalid => "That doesn't look like a server address.",
            AddError::Insecure => "The server must use https://.",
            AddError::Duplicate => "That server is already added.",
            AddError::Unreachable => "Couldn't reach the server.",
            AddError::NotDatrope => "That isn't a Datrope server.",
        }
    }
}

const LOCAL_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// Turns what the user typed into a server origin. `https://` is assumed; plain `http://` is only allowed for
/// localhost, and only when `allow_http_localhost` (development builds).
pub fn normalize_address(input: &str, allow_http_localhost: bool) -> Result<String, AddError> {
    let t = input.trim();
    if t.is_empty() {
        return Err(AddError::Invalid);
    }
    let with_scheme = if t.contains("://") {
        t.to_string()
    } else {
        format!("https://{t}")
    };
    let url = Url::parse(&with_scheme).map_err(|_| AddError::Invalid)?;
    accept_origin(&url, allow_http_localhost)
}

/// The origin of `url` if a server may live there: https, or http on localhost when `allow_http_localhost`.
/// Applied to what the user typed and to where the server's answer finally came from (after redirects).
pub fn accept_origin(url: &Url, allow_http_localhost: bool) -> Result<String, AddError> {
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AddError::Invalid);
    }
    let host = url.host_str().ok_or(AddError::Invalid)?;
    match url.scheme() {
        "https" => {}
        "http" if allow_http_localhost && LOCAL_HOSTS.contains(&host) => {}
        "http" => return Err(AddError::Insecure),
        _ => return Err(AddError::Invalid),
    }
    Ok(url.origin().ascii_serialization())
}

/// Whether a server webview may navigate to `target`: its own origin, the bundled app (offline page; `app_origin` is
/// the dev server in dev), or about:blank.
/// Everything else opens in the system browser.
pub fn navigation_allowed(server_origin: &str, app_origin: &str, target: &Url) -> bool {
    if target.as_str() == "about:blank" {
        return true;
    }
    if target.scheme() == "tauri" || target.host_str() == Some("tauri.localhost") {
        return true;
    }
    if !app_origin.is_empty()
        && app_origin != "null"
        && target.origin().ascii_serialization() == app_origin
    {
        return true;
    }
    target.origin().ascii_serialization() == server_origin
}

pub fn host_of(origin: &str) -> String {
    origin
        .split_once("://")
        .map_or(origin, |(_, h)| h)
        .to_string()
}

/// `GET /api/instance` answers with these fields on every Datrope server.
pub fn looks_like_datrope(v: &serde_json::Value) -> bool {
    v.get("registration_mode")
        .is_some_and(serde_json::Value::is_string)
        && v.get("has_users")
            .is_some_and(serde_json::Value::is_boolean)
}

/// Checks that `origin` answers like a Datrope server. Redirects are followed; returns the origin the answer
/// finally came from, held to the same scheme rule as typed addresses.
pub async fn probe(origin: &str, allow_http_localhost: bool) -> Result<String, AddError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| AddError::Unreachable)?;
    let res = client
        .get(format!("{origin}/api/instance"))
        .send()
        .await
        .map_err(|_| AddError::Unreachable)?;
    if !res.status().is_success() {
        return Err(AddError::NotDatrope);
    }
    let final_origin = accept_origin(res.url(), allow_http_localhost)?;
    let v: serde_json::Value = res.json().await.map_err(|_| AddError::NotDatrope)?;
    if looks_like_datrope(&v) {
        Ok(final_origin)
    } else {
        Err(AddError::NotDatrope)
    }
}

impl Store {
    /// A missing file means no servers yet. A file that can't be read or parsed is moved to `servers.json.bak`
    /// (replacing an older one) and loads as empty; the `bool` is true then, so callers don't treat the empty
    /// list as the truth (e.g. by deleting every server's data).
    pub fn load(path: &Path) -> (Store, bool) {
        let parsed = match std::fs::read(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (Store::default(), false),
            Err(_) => None,
            Ok(b) => serde_json::from_slice(&b).ok(),
        };
        match parsed {
            Some(store) => (store, false),
            None => {
                let bak = path.with_extension("json.bak");
                if let Err(e) = std::fs::rename(path, &bak) {
                    eprintln!("moving {} aside: {e}", path.display());
                }
                (Store::default(), true)
            }
        }
    }

    /// Writes through a temporary file, so a crash never leaves half a file.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(
            &tmp,
            serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?,
        )?;
        std::fs::rename(tmp, path)
    }

    pub fn add(&mut self, url: String, name: String) -> Result<Server, AddError> {
        if self.servers.iter().any(|s| s.url == url) {
            return Err(AddError::Duplicate);
        }
        let server = Server {
            id: uuid::Uuid::new_v4().to_string(),
            url,
            name,
            icon: None,
        };
        self.servers.push(server.clone());
        Ok(server)
    }

    pub fn remove(&mut self, id: &str) -> Option<Server> {
        let i = self.servers.iter().position(|s| s.id == id)?;
        Some(self.servers.remove(i))
    }

    /// Applies a new order. `ids` must name every server exactly once; anything else is ignored.
    pub fn reorder(&mut self, ids: &[String]) -> bool {
        if ids.len() != self.servers.len() || !self.servers.iter().all(|s| ids.contains(&s.id)) {
            return false;
        }
        self.servers
            .sort_by_key(|s| ids.iter().position(|id| *id == s.id));
        true
    }

    pub fn get(&self, id: &str) -> Option<&Server> {
        self.servers.iter().find(|s| s.id == id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut Server> {
        self.servers.iter_mut().find(|s| s.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_addresses() {
        let ok = |s: &str| normalize_address(s, false).unwrap();
        assert_eq!(ok("chat.example.com"), "https://chat.example.com");
        assert_eq!(
            ok("  Chat.Example.com/channels/1?x=1 "),
            "https://chat.example.com"
        );
        assert_eq!(ok("https://chat.example.com/"), "https://chat.example.com");
        assert_eq!(ok("chat.example.com:8443"), "https://chat.example.com:8443");
        assert_eq!(
            ok("https://chat.example.com:443"),
            "https://chat.example.com"
        );
        assert_eq!(normalize_address("", false), Err(AddError::Invalid));
        assert_eq!(
            normalize_address("ftp://x.example", false),
            Err(AddError::Invalid)
        );
        assert_eq!(
            normalize_address("https://user:pw@x.example", false),
            Err(AddError::Invalid)
        );
        assert_eq!(
            normalize_address("http://chat.example.com", false),
            Err(AddError::Insecure)
        );
        assert_eq!(
            normalize_address("http://chat.example.com", true),
            Err(AddError::Insecure)
        );
        assert_eq!(
            normalize_address("http://localhost:5173", false),
            Err(AddError::Insecure)
        );
        assert_eq!(
            normalize_address("http://localhost:5173", true).unwrap(),
            "http://localhost:5173"
        );
        assert_eq!(
            normalize_address("http://127.0.0.1:5173", true).unwrap(),
            "http://127.0.0.1:5173"
        );
    }

    #[test]
    fn store_add_remove_reorder_round_trip() {
        let dir = std::env::temp_dir().join(format!("datrope-store-{}", uuid::Uuid::new_v4()));
        let path = dir.join("servers.json");
        let mut s = Store::default();
        let a = s
            .add("https://a.example".into(), "a.example".into())
            .unwrap();
        let b = s
            .add("https://b.example".into(), "b.example".into())
            .unwrap();
        assert_eq!(
            s.add("https://a.example".into(), "again".into()),
            Err(AddError::Duplicate)
        );
        assert!(s.reorder(&[b.id.clone(), a.id.clone()]));
        assert!(
            !s.reorder(std::slice::from_ref(&b.id)),
            "not a permutation: ignored"
        );
        assert!(!s.reorder(&[b.id.clone(), "nope".into()]));
        s.tray_notice_shown = true;
        s.save(&path).unwrap();

        let (loaded, corrupt) = Store::load(&path);
        assert!(!corrupt);
        assert_eq!(
            loaded
                .servers
                .iter()
                .map(|x| x.id.as_str())
                .collect::<Vec<_>>(),
            [b.id.as_str(), a.id.as_str()]
        );
        assert!(loaded.tray_notice_shown);
        assert_eq!(loaded.get(&a.id).unwrap().url, "https://a.example");

        let mut loaded = loaded;
        assert_eq!(loaded.remove(&a.id).map(|x| x.id), Some(a.id.clone()));
        assert!(loaded.remove(&a.id).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_file_loads_empty() {
        let dir = std::env::temp_dir().join(format!("datrope-store-{}", uuid::Uuid::new_v4()));
        let (store, corrupt) = Store::load(&dir.join("servers.json"));
        assert!(store.servers.is_empty());
        assert!(!corrupt, "no file yet is not corruption");
    }

    #[test]
    fn corrupt_file_is_moved_aside_and_reported() {
        let dir = std::env::temp_dir().join(format!("datrope-store-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("servers.json");
        let bak = dir.join("servers.json.bak");
        std::fs::write(&bak, b"older backup").unwrap();
        std::fs::write(&path, b"{not json").unwrap();
        let (store, corrupt) = Store::load(&path);
        assert!(store.servers.is_empty());
        assert!(corrupt);
        assert!(!path.exists());
        assert_eq!(
            std::fs::read(&bak).unwrap(),
            b"{not json",
            "replaces the older backup"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn accepts_only_secure_origins() {
        let u = |s: &str| url::Url::parse(s).unwrap();
        assert_eq!(
            accept_origin(&u("https://www.example.com/api/instance"), false).unwrap(),
            "https://www.example.com"
        );
        assert_eq!(
            accept_origin(&u("http://www.example.com/api/instance"), true),
            Err(AddError::Insecure)
        );
        assert_eq!(
            accept_origin(&u("http://localhost:5173/api/instance"), false),
            Err(AddError::Insecure)
        );
        assert_eq!(
            accept_origin(&u("http://localhost:5173/api/instance"), true).unwrap(),
            "http://localhost:5173"
        );
        assert_eq!(
            accept_origin(&u("https://u:p@x.example/"), false),
            Err(AddError::Invalid)
        );
        assert_eq!(
            accept_origin(&u("file:///etc/passwd"), true),
            Err(AddError::Invalid)
        );
    }

    #[test]
    fn navigation_stays_on_the_server() {
        let u = |s: &str| url::Url::parse(s).unwrap();
        const APP: &str = "http://tauri.localhost";
        let origin = "https://chat.example.com";
        assert!(navigation_allowed(
            origin,
            APP,
            &u("https://chat.example.com/channels/1")
        ));
        assert!(navigation_allowed(
            origin,
            APP,
            &u("http://tauri.localhost/offline.html?id=x")
        ));
        assert!(navigation_allowed(
            origin,
            APP,
            &u("tauri://localhost/offline.html")
        ));
        assert!(navigation_allowed(origin, APP, &u("about:blank")));
        assert!(!navigation_allowed(
            origin,
            APP,
            &u("https://evil.example/")
        ));
        assert!(!navigation_allowed(
            origin,
            APP,
            &u("https://chat.example.com.evil.example/")
        ));
        assert!(
            !navigation_allowed(origin, APP, &u("http://chat.example.com/")),
            "scheme is part of the origin"
        );
        assert!(!navigation_allowed(origin, APP, &u("javascript:alert(1)")));
        assert!(!navigation_allowed(
            "https://chat.example.com",
            "null",
            &u("data:text/html,x")
        ));
        assert!(!navigation_allowed(
            "https://chat.example.com",
            "null",
            &u("javascript:alert(1)")
        ));
        let dev = u("http://localhost:1420/offline.html");
        assert!(navigation_allowed(origin, "http://localhost:1420", &dev));
        assert!(!navigation_allowed(origin, APP, &dev));
    }

    #[test]
    fn recognises_a_datrope_instance() {
        let v = serde_json::json!({ "registration_mode": "open", "has_users": true, "max_upload_bytes": 1 });
        assert!(looks_like_datrope(&v));
        assert!(!looks_like_datrope(&serde_json::json!({ "status": "ok" })));
        assert!(!looks_like_datrope(
            &serde_json::json!({ "registration_mode": 1, "has_users": true })
        ));
    }

    #[test]
    fn host_of_strips_scheme() {
        assert_eq!(
            host_of("https://chat.example.com:8443"),
            "chat.example.com:8443"
        );
        assert_eq!(host_of("http://localhost:5173"), "localhost:5173");
    }
}
