//! Small state machines the shell runs on behalf of all server webviews. Pure, so they are unit tested.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

/// Which server webview is in a call. Only one call at a time across servers.
#[derive(Default)]
pub struct VoiceTracker {
    in_call: Option<String>,
}

impl VoiceTracker {
    /// Records a join or leave. Returns the webview that must leave because `label` joined.
    pub fn set(&mut self, label: &str, in_call: bool) -> Option<String> {
        if in_call {
            self.in_call
                .replace(label.to_string())
                .filter(|prev| prev != label)
        } else {
            self.forget(label);
            None
        }
    }

    pub fn forget(&mut self, label: &str) {
        if self.in_call.as_deref() == Some(label) {
            self.in_call = None;
        }
    }

    pub fn in_call(&self) -> Option<&str> {
        self.in_call.as_deref()
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct PttUpdate {
    /// Global shortcut to unregister.
    pub unregister: Option<String>,
    /// Global shortcut to register.
    pub register: Option<String>,
    /// Webview that must receive `ptt { down: false }` because its held key stopped counting.
    pub release: Option<String>,
}

/// Owns the one global push-to-talk shortcut: the webview that set it gets its presses.
#[derive(Default)]
pub struct PttRouter {
    owner: Option<String>,
    key: Option<String>,
    down: bool,
}

impl PttRouter {
    /// `key: Some` makes `label` the owner of that key; `None` from the owner gives it up (others are ignored).
    pub fn set(&mut self, label: &str, key: Option<String>) -> PttUpdate {
        let is_owner = self.owner.as_deref() == Some(label);
        match key {
            None if !is_owner => PttUpdate::default(),
            None => {
                let release = self.take_release();
                self.owner = None;
                PttUpdate {
                    unregister: self.key.take(),
                    register: None,
                    release,
                }
            }
            Some(k) if is_owner && self.key.as_deref() == Some(k.as_str()) => PttUpdate::default(),
            Some(k) => {
                let release = self.take_release();
                self.owner = Some(label.to_string());
                PttUpdate {
                    unregister: self.key.replace(k.clone()),
                    register: Some(k),
                    release,
                }
            }
        }
    }

    fn take_release(&mut self) -> Option<String> {
        let held = std::mem::take(&mut self.down);
        if held {
            self.owner.clone()
        } else {
            None
        }
    }

    /// A press or release of the global shortcut. Returns where to send it, only when the state changes.
    pub fn press(&mut self, pressed: bool) -> Option<(String, bool)> {
        let owner = self.owner.clone()?;
        if pressed == self.down {
            return None;
        }
        self.down = pressed;
        Some((owner, pressed))
    }
}

/// Push-to-talk may only be taken by the webview that is in the call.
pub fn ptt_allowed(voice: &VoiceTracker, label: &str) -> bool {
    voice.in_call() == Some(label)
}

/// Applies a join/leave report. Returns the webview that must leave (handoff) and the push-to-talk updates for
/// every webview that is no longer in the call (a leaver, or the one displaced by a handoff).
pub fn voice_change(
    voice: &mut VoiceTracker,
    ptt: &mut PttRouter,
    label: &str,
    in_call: bool,
) -> (Option<String>, Vec<PttUpdate>) {
    let leave = voice.set(label, in_call);
    let mut updates = Vec::new();
    if !in_call {
        updates.push(ptt.set(label, None));
    }
    if let Some(displaced) = &leave {
        updates.push(ptt.set(displaced, None));
    }
    (leave, updates)
}

/// At most `max` calls per `window`, per key (a server id).
pub struct RateLimiter {
    max: usize,
    window: Duration,
    hits: HashMap<String, VecDeque<Instant>>,
}

impl RateLimiter {
    pub fn new(max: usize, window: Duration) -> Self {
        Self {
            max,
            window,
            hits: HashMap::new(),
        }
    }

    pub fn allow(&mut self, key: &str, now: Instant) -> bool {
        let q = self.hits.entry(key.to_string()).or_default();
        while q
            .front()
            .is_some_and(|t| now.duration_since(*t) >= self.window)
        {
            q.pop_front();
        }
        if q.len() >= self.max {
            return false;
        }
        q.push_back(now);
        true
    }

    pub fn forget(&mut self, key: &str) {
        self.hits.remove(key);
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Badge {
    pub unread: bool,
    pub mentions: u32,
}

/// Unread state per server id, as reported by each page.
#[derive(Default)]
pub struct Badges(HashMap<String, Badge>);

impl Badges {
    pub fn set(&mut self, id: &str, b: Badge) -> bool {
        self.0.insert(id.to_string(), b) != Some(b)
    }

    pub fn get(&self, id: &str) -> Badge {
        self.0.get(id).copied().unwrap_or_default()
    }

    pub fn remove(&mut self, id: &str) {
        self.0.remove(id);
    }

    pub fn total_mentions(&self) -> u32 {
        self.0.values().map(|b| b.mentions).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn joining_voice_elsewhere_makes_the_other_server_leave() {
        let mut v = VoiceTracker::default();
        assert_eq!(v.set("server-a", true), None);
        assert_eq!(
            v.set("server-a", true),
            None,
            "re-reporting is not a handoff"
        );
        assert_eq!(v.set("server-b", true), Some("server-a".into()));
        assert_eq!(v.in_call(), Some("server-b"));
        assert_eq!(
            v.set("server-a", false),
            None,
            "a stale leave from a does not clear b"
        );
        assert_eq!(v.in_call(), Some("server-b"));
        v.forget("server-b");
        assert_eq!(v.in_call(), None);
    }

    #[test]
    fn ptt_registers_for_its_owner_and_routes_presses() {
        let mut p = PttRouter::default();
        assert_eq!(p.press(true), None, "nobody owns the key");
        let u = p.set("server-a", Some("F8".into()));
        assert_eq!(
            u,
            PttUpdate {
                unregister: None,
                register: Some("F8".into()),
                release: None
            }
        );
        assert_eq!(p.press(true), Some(("server-a".into(), true)));
        assert_eq!(p.press(true), None, "auto-repeat is ignored");
        assert_eq!(p.press(false), Some(("server-a".into(), false)));
        assert_eq!(
            p.set("server-a", Some("F8".into())),
            PttUpdate::default(),
            "same key, nothing to do"
        );
    }

    #[test]
    fn ptt_releases_the_old_owner_when_ownership_moves_while_held() {
        let mut p = PttRouter::default();
        p.set("server-a", Some("F8".into()));
        p.press(true);
        let u = p.set("server-b", Some("F9".into()));
        assert_eq!(
            u,
            PttUpdate {
                unregister: Some("F8".into()),
                register: Some("F9".into()),
                release: Some("server-a".into())
            }
        );
        assert_eq!(p.press(false), None, "the old press ended with the handoff");
        assert_eq!(p.press(true), Some(("server-b".into(), true)));
    }

    #[test]
    fn ptt_owner_clearing_unregisters_and_releases() {
        let mut p = PttRouter::default();
        p.set("server-a", Some("F8".into()));
        assert_eq!(
            p.set("server-b", None),
            PttUpdate::default(),
            "only the owner can clear"
        );
        p.press(true);
        let u = p.set("server-a", None);
        assert_eq!(
            u,
            PttUpdate {
                unregister: Some("F8".into()),
                register: None,
                release: Some("server-a".into())
            }
        );
        assert_eq!(p.press(true), None);
    }

    #[test]
    fn ptt_key_change_by_owner_swaps_registration() {
        let mut p = PttRouter::default();
        p.set("server-a", Some("F8".into()));
        let u = p.set("server-a", Some("Backquote".into()));
        assert_eq!(
            u,
            PttUpdate {
                unregister: Some("F8".into()),
                register: Some("Backquote".into()),
                release: None
            }
        );
    }

    #[test]
    fn rate_limiter_allows_five_per_ten_seconds_per_key() {
        let mut r = RateLimiter::new(5, Duration::from_secs(10));
        let t0 = Instant::now();
        for _ in 0..5 {
            assert!(r.allow("a", t0));
        }
        assert!(!r.allow("a", t0 + Duration::from_secs(9)));
        assert!(r.allow("b", t0), "keys are independent");
        assert!(r.allow("a", t0 + Duration::from_secs(10)));
        r.forget("a");
        for _ in 0..5 {
            assert!(r.allow("a", t0 + Duration::from_secs(10)));
        }
    }

    #[test]
    fn badges_report_changes_and_totals() {
        let mut b = Badges::default();
        assert!(b.set(
            "a",
            Badge {
                unread: true,
                mentions: 2
            }
        ));
        assert!(!b.set(
            "a",
            Badge {
                unread: true,
                mentions: 2
            }
        ));
        b.set(
            "b",
            Badge {
                unread: false,
                mentions: 3,
            },
        );
        assert_eq!(b.total_mentions(), 5);
        assert_eq!(
            b.get("b"),
            Badge {
                unread: false,
                mentions: 3
            }
        );
        b.remove("a");
        assert_eq!(b.get("a"), Badge::default());
        assert_eq!(b.total_mentions(), 3);
    }

    #[test]
    fn only_the_page_in_the_call_may_take_the_key() {
        let mut voice = VoiceTracker::default();
        assert!(!ptt_allowed(&voice, "server-a"));
        voice.set("server-a", true);
        assert!(ptt_allowed(&voice, "server-a"));
        assert!(!ptt_allowed(&voice, "server-b"));
    }

    #[test]
    fn leaving_a_call_drops_the_held_key() {
        let (mut voice, mut ptt) = (VoiceTracker::default(), PttRouter::default());
        voice_change(&mut voice, &mut ptt, "server-a", true);
        ptt.set("server-a", Some("F8".into()));
        ptt.press(true);
        let (leave, updates) = voice_change(&mut voice, &mut ptt, "server-a", false);
        assert_eq!(leave, None);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].release.as_deref(), Some("server-a"));
        assert_eq!(updates[0].unregister.as_deref(), Some("F8"));
    }

    #[test]
    fn handoff_releases_the_displaced_owner_and_lets_the_new_page_take_the_key() {
        let (mut voice, mut ptt) = (VoiceTracker::default(), PttRouter::default());
        voice_change(&mut voice, &mut ptt, "server-a", true);
        ptt.set("server-a", Some("F8".into()));
        ptt.press(true);
        let (leave, updates) = voice_change(&mut voice, &mut ptt, "server-b", true);
        assert_eq!(leave.as_deref(), Some("server-a"));
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].release.as_deref(), Some("server-a"));
        assert_eq!(updates[0].unregister.as_deref(), Some("F8"));
        assert!(ptt_allowed(&voice, "server-b"));
        assert_eq!(
            ptt.set("server-b", Some("F8".into())).register.as_deref(),
            Some("F8")
        );
    }
}
