//! Colour tokens a server page sends for the app's own screens. Anything off-pattern drops the whole payload.
use std::collections::{BTreeMap, HashMap};

pub const TOKENS: &[&str] = &[
    "background",
    "foreground",
    "card",
    "card-foreground",
    "popover",
    "popover-foreground",
    "primary",
    "primary-foreground",
    "secondary",
    "secondary-foreground",
    "muted",
    "muted-foreground",
    "accent",
    "accent-foreground",
    "destructive",
    "destructive-foreground",
    "border",
    "input",
    "ring",
    "sidebar",
    "sidebar-foreground",
    "topbar",
    "topbar-foreground",
    "online",
    "idle",
    "offline",
];

const FUNCTIONS: &[&str] = &[
    "rgb(",
    "rgba(",
    "hsl(",
    "hsla(",
    "oklch(",
    "oklab(",
    "color-mix(",
];

fn colour(v: &str) -> bool {
    if v.is_empty()
        || v.len() > 200
        || v.chars()
            .any(|c| matches!(c, ';' | '{' | '}' | '<' | '>' | '"' | '\'' | '\\'))
    {
        return false;
    }
    if let Some(hex) = v.strip_prefix('#') {
        return matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit());
    }
    let lower = v.to_ascii_lowercase();
    if lower.contains("url(") || lower.contains("expression") || lower.contains("/*") {
        return false;
    }
    if !FUNCTIONS.iter().any(|f| lower.starts_with(f)) || !lower.ends_with(')') {
        return false;
    }
    let mut depth = 0i32;
    for c in lower.chars() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

/// The tokens if every entry is an allowlisted name with a colour value, else none.
pub fn validate(tokens: &HashMap<String, String>) -> Option<BTreeMap<String, String>> {
    if tokens.len() > 64 {
        return None;
    }
    let mut out = BTreeMap::new();
    for (k, v) in tokens {
        let v = v.trim();
        if !TOKENS.contains(&k.as_str()) || !colour(v) {
            return None;
        }
        out.insert(k.clone(), v.to_string());
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    fn m(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn accepts_colours() {
        let t = validate(&m(&[
            ("background", "#131313"),
            ("primary", "oklch(0.7 0.15 250)"),
            ("ring", "rgb(46, 204, 113)"),
        ]))
        .unwrap();
        assert_eq!(t.len(), 3);
    }
    #[test]
    fn drops_everything_on_one_bad_entry() {
        assert!(validate(&m(&[("background", "#131313"), ("card", "url(https://x)")])).is_none());
        assert!(validate(&m(&[("background", "#131313; color: red")])).is_none());
        assert!(validate(&m(&[("not-a-token", "#fff")])).is_none());
        assert!(
            validate(&m(&[("background", "red")])).is_none(),
            "keywords are not needed and not allowed"
        );
        assert!(
            validate(&m(&[("background", "rgb(1,2,3")])).is_none(),
            "unbalanced"
        );
    }
    #[test]
    fn limits_size() {
        let many: HashMap<String, String> =
            (0..65).map(|i| (format!("t{i}"), "#fff".into())).collect();
        assert!(validate(&many).is_none());
        assert!(validate(&m(&[("background", &format!("rgb({})", "1,".repeat(120)))])).is_none());
    }
}
