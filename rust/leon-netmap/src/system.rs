//! Reads the interface address, neighbour table and default route through `ip`, exactly as the
//! Python pass does, with a deadline and an output limit per command.

use std::collections::HashMap;
use std::io::{self, Read};
use std::net::Ipv4Addr;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(3);
pub const COMMAND_OUTPUT_LIMIT: u64 = 256 * 1024;
/// Wider subnets are refused: a /22 is at most 1022 hosts.
pub const MIN_PREFIX: u8 = 22;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Subnet {
    pub address: Ipv4Addr,
    pub prefix: u8,
}

impl Subnet {
    pub fn network(&self) -> Ipv4Addr {
        Ipv4Addr::from(u32::from(self.address) & self.mask())
    }

    fn mask(&self) -> u32 {
        u32::MAX
            .checked_shl(32 - u32::from(self.prefix))
            .unwrap_or(0)
    }

    fn broadcast(&self) -> Ipv4Addr {
        Ipv4Addr::from(u32::from(self.network()) | !self.mask())
    }

    /// The text form Python's `str(IPv4Network)` produces, e.g. `192.168.3.0/24`.
    pub fn network_text(&self) -> String {
        format!("{}/{}", self.network(), self.prefix)
    }

    /// Every host address except this node's, as Python's `IPv4Network.hosts()`: no network or
    /// broadcast address, except that /31 and /32 use all of theirs.
    pub fn targets(&self) -> Vec<Ipv4Addr> {
        let first = u32::from(self.network());
        let last = u32::from(self.broadcast());
        let (start, end) = if self.prefix >= 31 {
            (first, last)
        } else {
            (first + 1, last - 1)
        };
        (start..=end)
            .map(Ipv4Addr::from)
            .filter(|host| *host != self.address)
            .collect()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum SubnetError {
    NoAddress,
    /// Not RFC 1918 or wider than /22.
    Refused(String),
}

/// The first `inet a.b.c.d/p` of `ip -4 -o addr show dev IF`, accepted only when private and at
/// most a /22. Stricter than Python's `is_private`: loopback, link-local and documentation ranges
/// are refused as well.
pub fn parse_subnet(text: &str) -> Result<Subnet, SubnetError> {
    let mut words = text.split_whitespace();
    let cidr = loop {
        match words.next() {
            Some("inet") => break words.next().ok_or(SubnetError::NoAddress)?,
            Some(_) => continue,
            None => return Err(SubnetError::NoAddress),
        }
    };
    let (address, prefix) = cidr.split_once('/').ok_or(SubnetError::NoAddress)?;
    let address: Ipv4Addr = address.parse().map_err(|_| SubnetError::NoAddress)?;
    let prefix: u8 = prefix.parse().map_err(|_| SubnetError::NoAddress)?;
    if prefix > 32 {
        return Err(SubnetError::NoAddress);
    }
    let subnet = Subnet { address, prefix };
    if !subnet.network().is_private() || prefix < MIN_PREFIX {
        return Err(SubnetError::Refused(subnet.network_text()));
    }
    Ok(subnet)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NeighbourState {
    Reachable,
    Delay,
    Probe,
    Stale,
    Permanent,
}

impl NeighbourState {
    fn parse(text: &str) -> Option<Self> {
        match text {
            "REACHABLE" => Some(NeighbourState::Reachable),
            "DELAY" => Some(NeighbourState::Delay),
            "PROBE" => Some(NeighbourState::Probe),
            "STALE" => Some(NeighbourState::Stale),
            "PERMANENT" => Some(NeighbourState::Permanent),
            _ => None,
        }
    }

    /// The kernel confirmed the device recently; STALE and PERMANENT entries are only remembered.
    pub fn is_present(self) -> bool {
        match self {
            NeighbourState::Reachable | NeighbourState::Delay | NeighbourState::Probe => true,
            NeighbourState::Stale | NeighbourState::Permanent => false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Neighbour {
    pub mac: String,
    pub state: NeighbourState,
}

/// `ip -4 neigh show dev IF`: `ADDR lladdr MAC [router] STATE`. Entries without a hardware
/// address (INCOMPLETE, FAILED) and malformed lines are skipped.
pub fn parse_neighbours(text: &str) -> HashMap<Ipv4Addr, Neighbour> {
    let mut found = HashMap::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        let [address, "lladdr", mac, .., state] = parts.as_slice() else {
            continue;
        };
        let (Ok(address), Some(state)) = (address.parse(), NeighbourState::parse(state)) else {
            continue;
        };
        let mac = mac.to_ascii_lowercase();
        if is_mac(&mac) {
            found.insert(address, Neighbour { mac, state });
        }
    }
    found
}

fn is_mac(text: &str) -> bool {
    text.len() == 17
        && text.split(':').count() == 6
        && text
            .split(':')
            .all(|part| part.len() == 2 && part.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

/// `ip -4 route show default dev IF`: `default via ADDR ...`.
pub fn parse_gateway(text: &str) -> Option<Ipv4Addr> {
    let mut words = text.split_whitespace();
    while let Some(word) = words.next() {
        if word == "default" && words.next() == Some("via") {
            return words.next().and_then(|address| address.parse().ok());
        }
    }
    None
}

/// Interface names are passed to `ip` as one argument; still reject anything a kernel name
/// cannot be.
pub fn is_interface_name(name: &str) -> bool {
    (1..=15).contains(&name.len())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// Standard output of a successful `ip` call, or `None` on failure, timeout or excess output.
pub fn ip(arguments: &[&str]) -> Option<String> {
    run(Command::new("ip").args(arguments), COMMAND_TIMEOUT)
}

fn run(command: &mut Command, timeout: Duration) -> Option<String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    // The reader drains the pipe so a large table cannot block the child before the deadline.
    let reader = thread::spawn(move || -> io::Result<Vec<u8>> {
        let mut output = Vec::new();
        stdout
            .take(COMMAND_OUTPUT_LIMIT + 1)
            .read_to_end(&mut output)?;
        Ok(output)
    });
    let stop = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < stop => thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let output = reader.join().ok()?.ok()?;
    if !status?.success() || output.len() as u64 > COMMAND_OUTPUT_LIMIT {
        return None;
    }
    String::from_utf8(output).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subnet(text: &str) -> Result<Subnet, SubnetError> {
        parse_subnet(text)
    }

    #[test]
    fn reads_the_first_address_and_its_targets() {
        let parsed = subnet(
            "2: eth0    inet 192.168.3.48/24 brd 192.168.3.255 scope global dynamic eth0\\       valid_lft 80000sec\n2: eth0    inet 192.168.3.60/24 scope global secondary eth0",
        );
        let Ok(parsed) = parsed else {
            unreachable!("{parsed:?}");
        };
        assert_eq!(parsed.address, Ipv4Addr::new(192, 168, 3, 48));
        assert_eq!(parsed.network_text(), "192.168.3.0/24");
        let targets = parsed.targets();
        assert_eq!(targets.len(), 253);
        assert_eq!(targets.first(), Some(&Ipv4Addr::new(192, 168, 3, 1)));
        assert_eq!(targets.last(), Some(&Ipv4Addr::new(192, 168, 3, 254)));
        assert!(!targets.contains(&Ipv4Addr::new(192, 168, 3, 48)));
    }

    #[test]
    fn the_widest_allowed_subnet_is_a_slash_22() {
        let Ok(parsed) = subnet("inet 10.20.4.9/22 brd 10.20.7.255") else {
            unreachable!();
        };
        assert_eq!(parsed.targets().len(), 1021);
        assert_eq!(parsed.network_text(), "10.20.4.0/22");
        assert_eq!(
            subnet("inet 10.20.4.9/21"),
            Err(SubnetError::Refused("10.20.0.0/21".into()))
        );
    }

    #[test]
    fn refuses_public_loopback_link_local_and_malformed_addresses() {
        for text in [
            "inet 8.8.8.8/24",
            "inet 100.64.1.2/24",
            "inet 127.0.0.1/24",
            "inet 169.254.3.4/24",
        ] {
            assert!(
                matches!(subnet(text), Err(SubnetError::Refused(_))),
                "{text}"
            );
        }
        for text in [
            "",
            "inet",
            "inet 10.0.0.1",
            "inet 10.0.0.1/33",
            "inet 10.0.0/24",
        ] {
            assert_eq!(subnet(text), Err(SubnetError::NoAddress), "{text}");
        }
    }

    #[test]
    fn point_to_point_prefixes_match_python_hosts() {
        let Ok(slash31) = subnet("inet 10.0.0.0/31") else {
            unreachable!();
        };
        assert_eq!(slash31.targets(), vec![Ipv4Addr::new(10, 0, 0, 1)]);
        let Ok(slash32) = subnet("inet 10.0.0.5/32") else {
            unreachable!();
        };
        assert!(slash32.targets().is_empty());
    }

    #[test]
    fn parses_neighbour_states_and_skips_unusable_entries() {
        let table = parse_neighbours(
            "192.168.3.1 lladdr AA:BB:CC:DD:EE:01 router REACHABLE\n\
             192.168.3.7 lladdr aa:bb:cc:dd:ee:07 STALE\n\
             192.168.3.8 FAILED\n\
             192.168.3.9 INCOMPLETE\n\
             192.168.3.10 lladdr not-a-mac DELAY\n\
             bogus lladdr aa:bb:cc:dd:ee:11 REACHABLE\n\
             192.168.3.12 lladdr aa:bb:cc:dd:ee:12 NOARP\n",
        );
        assert_eq!(table.len(), 2);
        let router = table.get(&Ipv4Addr::new(192, 168, 3, 1));
        assert_eq!(router.map(|n| n.mac.as_str()), Some("aa:bb:cc:dd:ee:01"));
        assert_eq!(router.map(|n| n.state.is_present()), Some(true));
        let stale = table.get(&Ipv4Addr::new(192, 168, 3, 7));
        assert_eq!(stale.map(|n| n.state.is_present()), Some(false));
    }

    #[test]
    fn parses_the_default_gateway() {
        assert_eq!(
            parse_gateway("default via 192.168.3.1 proto dhcp src 192.168.3.48 metric 100"),
            Some(Ipv4Addr::new(192, 168, 3, 1))
        );
        assert_eq!(parse_gateway("default dev eth0 scope link"), None);
        assert_eq!(parse_gateway(""), None);
    }

    #[test]
    fn interface_names_are_validated() {
        assert!(is_interface_name("eth0"));
        assert!(is_interface_name("enx00e04c68.1"));
        assert!(!is_interface_name(""));
        assert!(!is_interface_name("eth0; reboot"));
        assert!(!is_interface_name("a-very-long-interface"));
    }

    #[test]
    fn commands_are_bounded_by_time_and_output() {
        let started = Instant::now();
        assert_eq!(
            run(Command::new("sleep").arg("5"), Duration::from_millis(100)),
            None
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(
            run(
                Command::new("sh").args(["-c", "printf ok"]),
                COMMAND_TIMEOUT
            ),
            Some("ok".into())
        );
        assert_eq!(run(&mut Command::new("false"), COMMAND_TIMEOUT), None);
        let flood = format!("head -c {} /dev/zero", COMMAND_OUTPUT_LIMIT + 10);
        assert_eq!(
            run(Command::new("sh").args(["-c", &flood]), COMMAND_TIMEOUT),
            None
        );
    }
}
