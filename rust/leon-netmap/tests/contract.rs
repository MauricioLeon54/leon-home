//! The Rust engine must fold a pass exactly like netmap.py: both run the cases in
//! Tests/Fixtures/netmap/merge-cases.json (generated from and checked against netmap.py).

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::path::Path;

use leon_netmap::state::{self, Pass, Scan};
use leon_netmap::system::parse_neighbours;
use serde_json::Value;

fn cases() -> Vec<Value> {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../Tests/Fixtures/netmap/merge-cases.json");
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let fixture: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    fixture["cases"].as_array().cloned().unwrap_or_default()
}

/// JSON equality where 1 and 1.0 are the same number, as for Python's json module.
fn same(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same(x, y))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, x)| b.get(key).is_some_and(|y| same(x, y)))
        }
        _ => left == right,
    }
}

#[test]
fn rust_merges_every_shared_case_like_python() {
    let cases = cases();
    assert_eq!(cases.len(), 3, "fixture missing or changed");
    for case in cases {
        let name = case["name"].as_str().unwrap_or("?");
        let stored = match &case["stored"] {
            Value::Null => state::Devices::new(),
            stored => state::parse(stored.to_string().as_bytes()),
        };
        let rtts: HashMap<Ipv4Addr, f64> = case["rtts"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(ip, rtt)| Some((ip.parse().ok()?, rtt.as_f64()?)))
            .collect();
        let table: String = case["neighbours"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|row| {
                let [ip, mac, state] = row.as_array()?.as_slice() else {
                    return None;
                };
                Some(format!(
                    "{} lladdr {} {}\n",
                    ip.as_str()?,
                    mac.as_str()?,
                    state.as_str()?
                ))
            })
            .collect();
        let neighbours = parse_neighbours(&table);
        let now = case["now"].as_i64().unwrap_or_default();
        let pass = Pass {
            rtts: &rtts,
            neighbours: &neighbours,
            router: case["router"].as_str().and_then(|ip| ip.parse().ok()),
            now,
        };
        let kept = state::merge(stored, &pass);
        let document = state::document(
            &kept,
            &Scan {
                ts: now,
                duration_ms: 1234,
                subnet: "192.168.3.0/24".into(),
            },
        );
        assert!(
            same(&document, &case["expected"]),
            "{name}\nrust:     {document}\nexpected: {}",
            case["expected"]
        );
    }
}
