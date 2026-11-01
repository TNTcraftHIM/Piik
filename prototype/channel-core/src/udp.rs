//! The configured IPv4 preparation destinations, shared by authority and Native.
use serde_json::Value;
use std::net::Ipv4Addr;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StunServer {
    pub host: String,
    pub port: u16,
}

/// Retain all distinct standard `stun:host[:port]` authorities in config order.
/// This is configuration eligibility, not DNS resolution or reachability proof.
pub fn stun_servers(ice_servers: &[Value]) -> Option<Vec<StunServer>> {
    let mut selected = Vec::new();
    for server in ice_servers {
        let Some(urls) = server.get("urls") else {
            continue;
        };
        let urls: &[Value] = match urls {
            Value::Array(urls) => urls,
            Value::String(_) => std::slice::from_ref(urls),
            _ => continue,
        };
        for url in urls {
            let Some(server) = url.as_str().and_then(parse_stun) else {
                continue;
            };
            if !selected.contains(&server) {
                selected.push(server);
            }
        }
    }
    (selected.len() >= 3).then_some(selected)
}

// This feature uses IPv4 sockets. A DNS authority may resolve to IPv4; an IPv6
// literal, TURN, STUNS, credentials, paths and transport queries are not inputs.
fn parse_stun(url: &str) -> Option<StunServer> {
    let (scheme, authority) = url.split_once(':')?;
    if !scheme.eq_ignore_ascii_case("stun") {
        return None;
    }
    let (host, port) = match authority.split_once(':') {
        Some((host, port)) => {
            if !port.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            (host, port.parse::<u16>().ok()?)
        }
        None => (authority, 3478),
    };
    let host = host.strip_suffix('.').unwrap_or(host).to_ascii_lowercase();
    if port == 0 || host.is_empty() || host.len() > 253 {
        return None;
    }
    if host.parse::<Ipv4Addr>().is_err()
        && !host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
    {
        return None;
    }
    Some(StunServer { host, port })
}
