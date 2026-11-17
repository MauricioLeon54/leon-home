//! One bounded inventory pass, run by leon-netmap.timer. Exit status 0 means a new state file
//! was written and synced. Pre-rename failures keep the previous file; a post-rename sync
//! failure leaves the new file visible with uncertain durability and exits 1.
//!
//! `leon-netmap --check` verifies the interface, subnet limits and ICMP socket permission for the
//! current identity and sandbox, then exits without sending a packet or writing state.

use std::env;
use std::hash::{BuildHasher, RandomState};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use leon_netmap::icmp::IcmpSocket;
use leon_netmap::state::{self, LockError, Pass, Scan, WriteError};
use leon_netmap::sweep::{self, Limits, PAYLOAD_BYTES, SweepError};
use leon_netmap::system::{self, SubnetError};

const DEFAULT_STATE_DIRECTORY: &str = "/var/lib/leon-netmap";
const DEFAULT_INTERFACE: &str = "eth0";

enum Failure {
    Interface,
    Subnet(String, SubnetError),
    Busy,
    Lock(std::io::Error),
    Socket(std::io::Error),
    Sweep(SweepError),
    Clock,
    Write(WriteError),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Interface => write!(formatter, "NETMAP_INTERFACE is not an interface name"),
            Failure::Subnet(interface, SubnetError::NoAddress) => {
                write!(formatter, "no IPv4 address on {interface}")
            }
            Failure::Subnet(_, SubnetError::Refused(network)) => {
                write!(formatter, "refusing to sweep {network}")
            }
            Failure::Busy => write!(formatter, "another inventory pass is running"),
            Failure::Lock(error) => write!(formatter, "lock failed: {}", error.kind()),
            Failure::Socket(error) => write!(formatter, "ICMP socket unavailable: {error}"),
            Failure::Sweep(error) => write!(formatter, "{error}; state kept"),
            Failure::Clock => write!(formatter, "system clock is before 1970"),
            Failure::Write(error @ WriteError::Durability(_)) => write!(formatter, "{error}"),
            Failure::Write(error) => write!(formatter, "{error}; state kept"),
        }
    }
}

fn main() -> ExitCode {
    let arguments: Vec<String> = env::args().skip(1).collect();
    let result = match arguments.as_slice() {
        [] => run(),
        [flag] if flag == "--check" => check(),
        _ => {
            eprintln!("usage: leon-netmap [--check]");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(failure) => {
            eprintln!("leon-netmap: {failure}");
            ExitCode::FAILURE
        }
    }
}

fn interface() -> Result<String, Failure> {
    let interface = env::var("NETMAP_INTERFACE").unwrap_or_else(|_| DEFAULT_INTERFACE.into());
    if system::is_interface_name(&interface) {
        Ok(interface)
    } else {
        Err(Failure::Interface)
    }
}

fn subnet(interface: &str) -> Result<system::Subnet, Failure> {
    let addresses = system::ip(&["-4", "-o", "addr", "show", "dev", interface]);
    system::parse_subnet(addresses.as_deref().unwrap_or_default())
        .map_err(|error| Failure::Subnet(interface.into(), error))
}

fn check() -> Result<(), Failure> {
    let interface = interface()?;
    let subnet = subnet(&interface)?;
    IcmpSocket::open().map_err(Failure::Socket)?;
    println!(
        "leon-netmap check: ICMP datagram socket available; /{} subnet, {} targets; nothing sent",
        subnet.prefix,
        subnet.targets().len()
    );
    Ok(())
}

fn run() -> Result<(), Failure> {
    let folder = PathBuf::from(
        env::var_os("STATE_DIRECTORY").unwrap_or_else(|| DEFAULT_STATE_DIRECTORY.into()),
    );
    let interface = interface()?;
    let _lock = state::lock(&folder).map_err(|error| match error {
        LockError::Busy => Failure::Busy,
        LockError::Io(error) => Failure::Lock(error),
    })?;

    let subnet = subnet(&interface)?;
    let targets = subnet.targets();
    let started = Instant::now();
    let outcome = {
        let mut transport = IcmpSocket::open().map_err(Failure::Socket)?;
        sweep::sweep(&targets, &mut transport, Limits::SERVICE, &payload())
            .map_err(Failure::Sweep)?
    };
    let neighbours = system::ip(&["-4", "neigh", "show", "dev", &interface])
        .map(|text| system::parse_neighbours(&text))
        .unwrap_or_default();
    let router = system::ip(&["-4", "route", "show", "default", "dev", &interface])
        .and_then(|text| system::parse_gateway(&text));

    let now = unix_seconds()?;
    let path = folder.join("state.json");
    let pass = Pass {
        rtts: &outcome.rtts,
        neighbours: &neighbours,
        router,
        now,
    };
    let kept = state::merge(state::load(&path), &pass);
    let scan = Scan {
        ts: now,
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        subnet: subnet.network_text(),
    };
    state::write(&path, &state::document(&kept, &scan)).map_err(Failure::Write)
}

/// A per-pass token echoed back by replies, so a reply to an earlier pass is never counted.
/// std's RandomState is keyed from the operating system's random source.
fn payload() -> [u8; PAYLOAD_BYTES] {
    let keys = RandomState::new();
    let mut payload = [0u8; PAYLOAD_BYTES];
    payload[..8].copy_from_slice(&keys.hash_one(1u8).to_ne_bytes());
    payload[8..].copy_from_slice(&keys.hash_one(2u8).to_ne_bytes());
    payload
}

fn unix_seconds() -> Result<i64, Failure> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Failure::Clock)?;
    i64::try_from(elapsed.as_secs()).map_err(|_| Failure::Clock)
}
