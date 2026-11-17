//! The persistent inventory (`state.json`) shared with netmap.py: loading, folding one pass in,
//! retention and atomic replacement. Field names and semantics are the collector's contract.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, Read, Write};
use std::net::Ipv4Addr;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde_json::{Map, Number, Value, json};

use crate::system::Neighbour;

/// Presence strip length: four hours of five-minute passes.
pub const PRESENCE: usize = 48;
pub const FORGET_SECONDS: i64 = 30 * 86_400;
/// Stored devices; the web projection separately shows at most 64.
pub const MAX_DEVICES: usize = 256;
/// The collector refuses larger inventories.
pub const MAX_STATE_BYTES: usize = 1_048_576;

/// One stored device. Unknown fields written by other tools are carried through unchanged.
#[derive(Clone, Debug, PartialEq)]
pub struct Device {
    pub ip: Ipv4Addr,
    pub first_seen: i64,
    pub last_seen: i64,
    pub strip: Vec<u8>,
    pub mac: Option<String>,
    pub online: u8,
    /// Absent until first seen; `Some(None)` is a device seen only through ARP.
    pub rtt_ms: Option<Option<f64>>,
    pub role: String,
    pub extra: Map<String, Value>,
}

impl Device {
    fn new(ip: Ipv4Addr, now: i64) -> Self {
        Device {
            ip,
            first_seen: now,
            last_seen: 0,
            strip: Vec::new(),
            mac: None,
            online: 0,
            rtt_ms: None,
            role: String::new(),
            extra: Map::new(),
        }
    }

    /// A stored device, or `None` when its address is unusable. Damaged fields get defaults so
    /// one bad entry cannot stop the pass (as netmap.py's `clean`).
    fn from_value(value: Value) -> Option<Self> {
        let Value::Object(mut fields) = value else {
            return None;
        };
        let ip = fields.remove("ip")?.as_str()?.parse().ok()?;
        let integer = |value: Option<Value>| value.and_then(|v| v.as_i64()).unwrap_or(0);
        let first_seen = integer(fields.remove("first_seen"));
        let last_seen = integer(fields.remove("last_seen"));
        let strip = match fields.remove("strip") {
            Some(Value::Array(values)) => values
                .iter()
                .filter_map(Value::as_u64)
                .filter(|v| *v <= 1)
                .map(|v| u8::from(v == 1))
                .collect(),
            _ => Vec::new(),
        };
        let mac = match fields.remove("mac") {
            Some(Value::String(mac)) => Some(mac),
            _ => None,
        };
        fields.remove("online");
        let rtt_ms = fields.remove("rtt_ms").map(|value| value.as_f64());
        let role = match fields.remove("role") {
            Some(Value::String(role)) => role,
            _ => String::new(),
        };
        Some(Device {
            ip,
            first_seen,
            last_seen,
            strip,
            mac,
            online: 0,
            rtt_ms,
            role,
            extra: fields,
        })
    }

    fn to_value(&self) -> Value {
        let mut fields = self.extra.clone();
        fields.insert("ip".into(), json!(self.ip.to_string()));
        fields.insert("first_seen".into(), json!(self.first_seen));
        fields.insert("last_seen".into(), json!(self.last_seen));
        fields.insert("strip".into(), json!(self.strip));
        if let Some(mac) = &self.mac {
            fields.insert("mac".into(), json!(mac));
        }
        fields.insert("online".into(), json!(self.online));
        if let Some(rtt) = self.rtt_ms {
            let number = rtt
                .and_then(Number::from_f64)
                .map_or(Value::Null, Value::Number);
            fields.insert("rtt_ms".into(), number);
        }
        fields.insert("role".into(), json!(self.role));
        Value::Object(fields)
    }
}

pub type Devices = BTreeMap<Ipv4Addr, Device>;

/// Devices from an existing state document; anything unreadable starts an empty inventory.
pub fn parse(raw: &[u8]) -> Devices {
    if raw.len() > MAX_STATE_BYTES {
        return Devices::new();
    }
    let Ok(Value::Object(mut state)) = serde_json::from_slice::<Value>(raw) else {
        return Devices::new();
    };
    let Some(Value::Array(items)) = state.remove("devices") else {
        return Devices::new();
    };
    items
        .into_iter()
        .filter_map(Device::from_value)
        .map(|device| (device.ip, device))
        .collect()
}

pub fn load(path: &Path) -> Devices {
    let Ok(file) = File::open(path) else {
        return Devices::new();
    };
    let mut raw = Vec::new();
    match file.take(MAX_STATE_BYTES as u64 + 1).read_to_end(&mut raw) {
        Ok(_) => parse(&raw),
        Err(_) => Devices::new(),
    }
}

/// One pass's observations.
pub struct Pass<'a> {
    pub rtts: &'a HashMap<Ipv4Addr, f64>,
    pub neighbours: &'a HashMap<Ipv4Addr, Neighbour>,
    pub router: Option<Ipv4Addr>,
    pub now: i64,
}

/// Folds one pass into the stored devices and drops forgotten ones; the result is sorted by
/// address. Mirrors netmap.py's `merge`.
pub fn merge(mut devices: Devices, pass: &Pass<'_>) -> Vec<Device> {
    let addresses: BTreeSet<Ipv4Addr> = devices
        .keys()
        .chain(pass.rtts.keys())
        .chain(pass.neighbours.keys())
        .copied()
        .collect();
    for ip in addresses {
        let neighbour = pass.neighbours.get(&ip);
        let rtt = pass.rtts.get(&ip).copied();
        let seen = rtt.is_some() || neighbour.is_some_and(|n| n.state.is_present());
        let device = devices
            .entry(ip)
            .or_insert_with(|| Device::new(ip, pass.now));
        if let Some(neighbour) = neighbour {
            device.mac = Some(neighbour.mac.clone());
        }
        device.online = u8::from(seen);
        device.strip.push(u8::from(seen));
        let excess = device.strip.len().saturating_sub(PRESENCE);
        device.strip.drain(..excess);
        if seen {
            device.last_seen = pass.now;
            device.rtt_ms = Some(rtt);
        }
        if pass.router == Some(ip) {
            device.role = "router".into();
        }
    }
    devices
        .into_values()
        .filter(|device| pass.now.saturating_sub(device.last_seen) <= FORGET_SECONDS)
        .collect()
}

pub struct Scan {
    pub ts: i64,
    pub duration_ms: u64,
    pub subnet: String,
}

/// The state document: at most MAX_DEVICES devices; `online` counts every kept device.
pub fn document(kept: &[Device], scan: &Scan) -> Value {
    let online: u64 = kept.iter().map(|device| u64::from(device.online)).sum();
    let devices: Vec<Value> = kept
        .iter()
        .take(MAX_DEVICES)
        .map(Device::to_value)
        .collect();
    json!({
        "devices": devices,
        "lastScan": {
            "ts": scan.ts,
            "durationMs": scan.duration_ms,
            "subnet": scan.subnet,
            "online": online,
        },
    })
}

#[derive(Debug)]
pub enum WriteError {
    TooLarge(usize),
    Io(io::Error),
    Durability(io::Error),
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WriteError::TooLarge(bytes) => {
                write!(
                    formatter,
                    "inventory of {bytes} bytes exceeds the collector limit"
                )
            }
            WriteError::Io(error) => write!(formatter, "state write failed: {}", error.kind()),
            WriteError::Durability(error) => write!(
                formatter,
                "state replaced but directory sync failed: {}",
                error.kind()
            ),
        }
    }
}

/// Replaces `path` atomically. Pre-rename errors keep the old state. A directory sync error
/// after rename leaves the new state visible, but its durability across power loss is unknown.
pub fn write(path: &Path, state: &Value) -> Result<(), WriteError> {
    write_with_directory_sync(path, state, |folder| File::open(folder)?.sync_all())
}

fn write_with_directory_sync(
    path: &Path,
    state: &Value,
    sync_directory: impl FnOnce(&Path) -> io::Result<()>,
) -> Result<(), WriteError> {
    let data = serde_json::to_vec(state).map_err(|error| WriteError::Io(error.into()))?;
    if data.len() > MAX_STATE_BYTES {
        return Err(WriteError::TooLarge(data.len()));
    }
    let temporary = temporary_path(path);
    let result = write_temporary(&temporary, &data).and_then(|()| fs::rename(&temporary, path));
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(WriteError::Io(error));
    }
    let folder = path.parent().filter(|p| !p.as_os_str().is_empty());
    sync_directory(folder.unwrap_or(Path::new("."))).map_err(WriteError::Durability)
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".tmp");
    PathBuf::from(name)
}

fn write_temporary(path: &Path, data: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o644)
        .open(path)?;
    file.write_all(data)?;
    file.sync_all()?;
    // The mode given to open() is reduced by the umask; consumers in other groups read it.
    fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o644))
}

pub enum LockError {
    Busy,
    Io(io::Error),
}

/// Held for the whole pass (shared with netmap.py): a manual run cannot overlap the timer's.
pub fn lock(folder: &Path) -> Result<File, LockError> {
    let file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(folder.join(".netmap.lock"))
        .map_err(LockError::Io)?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(LockError::Busy),
        Err(TryLockError::Error(error)) => Err(LockError::Io(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::system::NeighbourState;

    fn ip(last: u8) -> Ipv4Addr {
        Ipv4Addr::new(192, 168, 3, last)
    }

    fn neighbour(mac: &str, state: NeighbourState) -> Neighbour {
        Neighbour {
            mac: mac.into(),
            state,
        }
    }

    fn folder() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "leon-netmap-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&path);
        let _ = fs::create_dir_all(&path);
        path
    }

    #[test]
    fn damaged_documents_start_an_empty_inventory() {
        for raw in [&b"not json"[..], b"[]", b"{}", b"{\"devices\": 3}"] {
            assert!(parse(raw).is_empty());
        }
        let oversized = vec![b' '; MAX_STATE_BYTES + 1];
        assert!(parse(&oversized).is_empty());
    }

    #[test]
    fn damaged_devices_are_dropped_or_repaired() {
        let devices = parse(
            br#"{"devices": [
                {"ip": "192.168.3.300"}, {"ip": 5}, "junk", {"name": "no ip"},
                {"ip": "192.168.3.9", "last_seen": "soon", "first_seen": 1.5,
                 "strip": [1, true, 2, 0, 1.0], "mac": 7, "role": 3, "rtt_ms": "x",
                 "label": {"name": "kept"}}
            ]}"#,
        );
        assert_eq!(devices.len(), 1);
        let device = &devices[&ip(9)];
        assert_eq!((device.first_seen, device.last_seen), (0, 0));
        assert_eq!(device.strip, vec![1, 0]);
        assert_eq!(device.mac, None);
        assert_eq!(device.role, "");
        assert_eq!(device.rtt_ms, Some(None));
        assert_eq!(device.extra.get("label"), Some(&json!({"name": "kept"})));
    }

    #[test]
    fn merges_a_pass_with_presence_retention_and_roles() {
        let now = 2_000_000_000;
        let mut stored = Devices::new();
        let mut old = Device::new(ip(5), 100);
        old.last_seen = now - FORGET_SECONDS - 1;
        stored.insert(ip(5), old);
        let mut quiet = Device::new(ip(6), 100);
        quiet.last_seen = now - 600;
        quiet.rtt_ms = Some(Some(2.5));
        quiet.strip = vec![1; PRESENCE];
        stored.insert(ip(6), quiet);
        let rtts = HashMap::from([(ip(1), 0.42)]);
        let neighbours = HashMap::from([
            (
                ip(1),
                neighbour("aa:bb:cc:dd:ee:01", NeighbourState::Reachable),
            ),
            (ip(7), neighbour("aa:bb:cc:dd:ee:07", NeighbourState::Delay)),
            (ip(8), neighbour("aa:bb:cc:dd:ee:08", NeighbourState::Stale)),
        ]);
        let pass = Pass {
            rtts: &rtts,
            neighbours: &neighbours,
            router: Some(ip(1)),
            now,
        };
        let kept = merge(stored, &pass);
        let addresses: Vec<Ipv4Addr> = kept.iter().map(|device| device.ip).collect();
        // Forgotten (.5) and never-seen ARP-stale (.8) entries are dropped.
        assert_eq!(addresses, vec![ip(1), ip(6), ip(7)]);
        let router = &kept[0];
        assert_eq!((router.online, router.role.as_str()), (1, "router"));
        assert_eq!(
            router.strip,
            vec![1],
            "one strip entry per pass, even when seen twice"
        );
        assert_eq!(router.rtt_ms, Some(Some(0.42)));
        assert_eq!((router.first_seen, router.last_seen), (now, now));
        let quiet = &kept[1];
        assert_eq!(quiet.online, 0);
        assert_eq!(quiet.strip.len(), PRESENCE);
        assert_eq!(quiet.strip.last(), Some(&0));
        assert_eq!(quiet.rtt_ms, Some(Some(2.5)), "last RTT kept while unseen");
        assert_eq!(quiet.last_seen, now - 600);
        let arp_only = &kept[2];
        assert_eq!(arp_only.rtt_ms, Some(None));
        assert_eq!(arp_only.mac.as_deref(), Some("aa:bb:cc:dd:ee:07"));
    }

    #[test]
    fn the_document_is_bounded_and_counts_every_kept_device() {
        let now = 2_000_000_000;
        let kept: Vec<Device> = (0..300u32)
            .map(|n| {
                let mut device = Device::new(Ipv4Addr::from(0x0a00_0000 + n), now);
                device.online = 1;
                device
            })
            .collect();
        let state = document(
            &kept,
            &Scan {
                ts: now,
                duration_ms: 5,
                subnet: "10.0.0.0/22".into(),
            },
        );
        assert_eq!(state["devices"].as_array().map(Vec::len), Some(MAX_DEVICES));
        assert_eq!(state["lastScan"]["online"], json!(300));
    }

    #[test]
    fn writes_atomically_with_readable_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let folder = folder();
        let path = folder.join("state.json");
        assert!(write(&path, &json!({"devices": []})).is_ok());
        let mode = fs::metadata(&path).map(|m| m.permissions().mode() & 0o777);
        assert_eq!(mode.ok(), Some(0o644));
        assert!(!temporary_path(&path).exists());
        assert_eq!(load(&path).len(), 0);
        let _ = fs::remove_dir_all(folder);
    }

    #[test]
    fn a_failed_write_keeps_the_previous_state() {
        let folder = folder();
        let path = folder.join("state.json");
        let _ = fs::write(&path, br#"{"devices": [{"ip": "192.168.3.4"}]}"#);
        let huge = json!({"devices": [{"ip": "192.168.3.4", "pad": "x".repeat(MAX_STATE_BYTES)}]});
        assert!(matches!(write(&path, &huge), Err(WriteError::TooLarge(_))));
        // A directory where the temporary file should go makes the write itself fail.
        let _ = fs::create_dir(temporary_path(&path));
        let _ = fs::write(temporary_path(&path).join("x"), b"");
        assert!(matches!(write(&path, &json!({})), Err(WriteError::Io(_))));
        assert_eq!(load(&path).len(), 1);
        let _ = fs::remove_dir_all(folder);
    }

    #[test]
    fn a_post_rename_sync_failure_reports_uncertain_durability_of_the_new_state() {
        let folder = folder();
        let path = folder.join("state.json");
        let _ = fs::write(&path, b"old");
        let state = json!({"devices": []});
        let result = write_with_directory_sync(&path, &state, |_| {
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        });
        assert!(matches!(result, Err(WriteError::Durability(_))));
        let replaced = fs::read(&path)
            .ok()
            .and_then(|data| serde_json::from_slice::<Value>(&data).ok());
        assert_eq!(replaced, Some(state));
        assert!(!temporary_path(&path).exists());
        let _ = fs::remove_dir_all(folder);
    }

    #[test]
    fn a_second_pass_cannot_take_the_lock() {
        let folder = folder();
        let first = lock(&folder);
        assert!(first.is_ok());
        assert!(matches!(lock(&folder), Err(LockError::Busy)));
        drop(first);
        // Tests running in parallel spawn children; one may hold an inherited copy of the
        // descriptor between fork and exec (close-on-exec), so allow that brief window.
        let reacquired = (0..100).any(|_| {
            let taken = lock(&folder).is_ok();
            if !taken {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            taken
        });
        assert!(reacquired);
        let _ = fs::remove_dir_all(folder);
    }
}
