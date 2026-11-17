//! Bounded echo sweep over an abstract transport: one request per target, a fixed window of
//! outstanding requests and a reply deadline per request. Silence means "not seen this pass".

use std::collections::HashMap;
use std::io;
use std::net::Ipv4Addr;
use std::time::{Duration, Instant};

pub const PAYLOAD_BYTES: usize = 16;
pub const ECHO_REQUEST: u8 = 8;
pub const ECHO_REPLY: u8 = 0;
/// A /22 has 1022 hosts; sequence numbers are target indexes and must fit in 16 bits.
pub const MAX_TARGETS: usize = 1024;
pub const RECEIVE_BUFFER_BYTES: usize = 512;

/// One unprivileged ICMP echo channel.
pub trait Transport {
    fn send(
        &mut self,
        to: Ipv4Addr,
        sequence: u16,
        payload: &[u8; PAYLOAD_BYTES],
    ) -> io::Result<()>;
    /// The echo identifier the kernel assigned, when known (Linux sets it on the first send).
    fn identifier(&self) -> Option<u16>;
    /// One datagram within `timeout`, or `None` when the wait ended without one.
    fn receive(
        &mut self,
        buffer: &mut [u8],
        timeout: Duration,
    ) -> io::Result<Option<(Ipv4Addr, usize)>>;
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub window: usize,
    pub reply_timeout: Duration,
    pub deadline: Duration,
}

impl Limits {
    /// The legacy sweep's bounds: 32 concurrent `ping -W 1` children within the 90 s unit.
    pub const SERVICE: Limits = Limits {
        window: 32,
        reply_timeout: Duration::from_secs(1),
        deadline: Duration::from_secs(60),
    };
}

#[derive(Debug, Default, PartialEq)]
pub struct Outcome {
    /// Round-trip time in milliseconds, rounded to microseconds, for targets that replied.
    pub rtts: HashMap<Ipv4Addr, f64>,
    pub sent: usize,
    pub send_errors: usize,
    pub ignored_packets: usize,
}

#[derive(Debug)]
pub enum SweepError {
    TooManyTargets(usize),
    /// The kernel refused ICMP echo for this identity (ping_group_range or sandbox).
    NotPermitted(io::Error),
    /// Targets existed but no request could be sent.
    NothingSent,
    Deadline,
    ReadBudgetExhausted,
}

impl std::fmt::Display for SweepError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SweepError::TooManyTargets(count) => {
                write!(formatter, "{count} targets exceed the limit")
            }
            SweepError::NotPermitted(error) => {
                write!(formatter, "ICMP echo not permitted: {error}")
            }
            SweepError::NothingSent => write!(formatter, "no ICMP echo could be sent"),
            SweepError::Deadline => write!(formatter, "inventory deadline exceeded"),
            SweepError::ReadBudgetExhausted => write!(formatter, "ICMP receive budget exhausted"),
        }
    }
}

/// True only for a well-formed echo reply to request `sequence` of this pass.
pub fn is_echo_reply(
    data: &[u8],
    sequence: u16,
    payload: &[u8; PAYLOAD_BYTES],
    identifier: Option<u16>,
) -> bool {
    let Some(header) = data.get(..8) else {
        return false;
    };
    let Some(body) = data.get(8..8 + PAYLOAD_BYTES) else {
        return false;
    };
    let ident = u16::from_be_bytes([header[4], header[5]]);
    let seq = u16::from_be_bytes([header[6], header[7]]);
    header[0] == ECHO_REPLY
        && header[1] == 0
        && seq == sequence
        && identifier.is_none_or(|expected| expected == ident)
        && body == payload
}

/// Sends one echo per target with at most `limits.window` outstanding. Late, duplicate, foreign
/// and malformed packets are ignored; the number of packets read is bounded so a flood cannot
/// extend the pass beyond its deadline.
pub fn sweep<T: Transport>(
    targets: &[Ipv4Addr],
    transport: &mut T,
    limits: Limits,
    payload: &[u8; PAYLOAD_BYTES],
) -> Result<Outcome, SweepError> {
    if targets.len() > MAX_TARGETS {
        return Err(SweepError::TooManyTargets(targets.len()));
    }
    let window = limits.window.max(1);
    let stop = Instant::now() + limits.deadline;
    let mut budget = 4 * targets.len() + 64;
    let mut outcome = Outcome::default();
    let mut pending: HashMap<Ipv4Addr, (u16, Instant)> = HashMap::with_capacity(window);
    let mut identifier = None;
    let mut queue = targets.iter().copied().zip(0u16..);
    let mut exhausted = false;
    let mut buffer = [0u8; RECEIVE_BUFFER_BYTES];
    loop {
        // Expire before refilling, so a slot freed by a timeout is reused at once rather than
        // idling until the next wake-up when requests went out in staggered groups.
        let now = Instant::now();
        pending.retain(|_, (_, sent)| now.duration_since(*sent) < limits.reply_timeout);
        while !exhausted && pending.len() < window {
            let Some((ip, sequence)) = queue.next() else {
                exhausted = true;
                break;
            };
            if Instant::now() >= stop {
                return Err(SweepError::Deadline);
            }
            match transport.send(ip, sequence, payload) {
                Ok(()) => {
                    pending.insert(ip, (sequence, Instant::now()));
                    outcome.sent += 1;
                    if identifier.is_none() {
                        identifier = transport.identifier();
                    }
                }
                Err(error) if is_permission_error(&error) => {
                    return Err(SweepError::NotPermitted(error));
                }
                Err(_) => outcome.send_errors += 1,
            }
        }
        let now = Instant::now();
        if pending.is_empty() && exhausted {
            break;
        }
        if now >= stop {
            return Err(SweepError::Deadline);
        }
        if budget == 0 {
            return Err(SweepError::ReadBudgetExhausted);
        }
        let Some(oldest) = pending.values().map(|(_, sent)| *sent).min() else {
            continue;
        };
        let wait = (oldest + limits.reply_timeout)
            .saturating_duration_since(now)
            .min(stop.saturating_duration_since(now));
        let received = transport.receive(&mut buffer, wait);
        if !matches!(received, Ok(None)) {
            budget -= 1;
        }
        let Ok(Some((source, length))) = received else {
            // A socket error is not a reply; the budget bounds a socket that keeps failing.
            outcome.ignored_packets += usize::from(received.is_err());
            continue;
        };
        let data = buffer.get(..length).unwrap_or(&[]);
        match pending.get(&source) {
            Some(&(sequence, sent)) if is_echo_reply(data, sequence, payload, identifier) => {
                let milliseconds = sent.elapsed().as_secs_f64() * 1000.0;
                outcome
                    .rtts
                    .insert(source, (milliseconds * 1000.0).round() / 1000.0);
                pending.remove(&source);
            }
            _ => outcome.ignored_packets += 1,
        }
    }
    if !targets.is_empty() && outcome.sent == 0 {
        return Err(SweepError::NothingSent);
    }
    Ok(outcome)
}

fn is_permission_error(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    const PAYLOAD: [u8; PAYLOAD_BYTES] = *b"leon-netmap-test";

    /// Replies are scripted per target: `Some(delay)` answers after that delay.
    struct FakeTransport {
        replies: HashMap<Ipv4Addr, Duration>,
        extra: VecDeque<(Ipv4Addr, Vec<u8>)>,
        inbox: Vec<(Instant, Ipv4Addr, Vec<u8>)>,
        send_error: Option<io::ErrorKind>,
        /// Sleep this long inside the n-th send (0-based): staggers the requests in flight.
        stall: Option<(usize, Duration)>,
        outstanding_peak: usize,
        sent: Vec<Ipv4Addr>,
        answered: usize,
    }

    impl FakeTransport {
        fn new(replies: &[(Ipv4Addr, Duration)]) -> Self {
            FakeTransport {
                replies: replies.iter().copied().collect(),
                extra: VecDeque::new(),
                inbox: Vec::new(),
                send_error: None,
                stall: None,
                outstanding_peak: 0,
                sent: Vec::new(),
                answered: 0,
            }
        }
    }

    fn reply(kind: u8, ident: u16, sequence: u16, payload: &[u8]) -> Vec<u8> {
        let mut packet = vec![kind, 0, 0, 0];
        packet.extend_from_slice(&ident.to_be_bytes());
        packet.extend_from_slice(&sequence.to_be_bytes());
        packet.extend_from_slice(payload);
        packet
    }

    impl Transport for FakeTransport {
        fn send(&mut self, to: Ipv4Addr, sequence: u16, payload: &[u8; 16]) -> io::Result<()> {
            if let Some(kind) = self.send_error {
                return Err(io::Error::from(kind));
            }
            if let Some((index, delay)) = self.stall
                && index == self.sent.len()
            {
                std::thread::sleep(delay);
            }
            self.sent.push(to);
            if let Some(delay) = self.replies.get(&to) {
                let packet = reply(ECHO_REPLY, 7, sequence, payload);
                self.inbox
                    .push((Instant::now() + *delay, to, packet.clone()));
                // A duplicate of every answer arrives right after it.
                self.inbox.push((Instant::now() + *delay, to, packet));
            }
            let outstanding = self.sent.len() - self.answered;
            self.outstanding_peak = self.outstanding_peak.max(outstanding);
            Ok(())
        }

        fn identifier(&self) -> Option<u16> {
            Some(7)
        }

        fn receive(
            &mut self,
            buffer: &mut [u8],
            timeout: Duration,
        ) -> io::Result<Option<(Ipv4Addr, usize)>> {
            if let Some((source, packet)) = self.extra.pop_front() {
                buffer[..packet.len()].copy_from_slice(&packet);
                return Ok(Some((source, packet.len())));
            }
            let limit = Instant::now() + timeout;
            self.inbox.sort_by_key(|(at, _, _)| *at);
            match self.inbox.first() {
                Some((at, _, _)) if *at <= limit => {
                    let (at, source, packet) = self.inbox.remove(0);
                    std::thread::sleep(at.saturating_duration_since(Instant::now()));
                    buffer[..packet.len()].copy_from_slice(&packet);
                    self.answered += 1;
                    Ok(Some((source, packet.len())))
                }
                _ => {
                    std::thread::sleep(timeout);
                    // Every outstanding request has now expired.
                    self.answered = self.sent.len();
                    Ok(None)
                }
            }
        }
    }

    fn hosts(count: u8) -> Vec<Ipv4Addr> {
        (1..=count)
            .map(|last| Ipv4Addr::new(10, 9, 0, last))
            .collect()
    }

    fn fast() -> Limits {
        Limits {
            window: 4,
            reply_timeout: Duration::from_millis(40),
            deadline: Duration::from_secs(5),
        }
    }

    #[test]
    fn records_replies_and_treats_silence_as_not_seen() {
        let targets = hosts(10);
        let mut transport = FakeTransport::new(&[
            (targets[0], Duration::from_millis(1)),
            (targets[5], Duration::from_millis(5)),
        ]);
        let outcome = sweep(&targets, &mut transport, fast(), &PAYLOAD).unwrap_or_default();
        assert_eq!(outcome.sent, 10);
        assert_eq!(outcome.rtts.len(), 2);
        assert!(outcome.rtts.contains_key(&targets[0]));
        assert!(outcome.rtts.contains_key(&targets[5]));
        assert!(!outcome.rtts.contains_key(&targets[1]));
        // Each answer's duplicate is ignored.
        assert_eq!(outcome.ignored_packets, 2);
    }

    #[test]
    fn never_exceeds_the_window_and_sends_each_target_once() {
        let targets = hosts(20);
        let mut transport = FakeTransport::new(&[]);
        let outcome = sweep(&targets, &mut transport, fast(), &PAYLOAD).unwrap_or_default();
        assert!(
            transport.outstanding_peak <= 4,
            "peak {}",
            transport.outstanding_peak
        );
        assert_eq!(transport.sent, targets);
        assert!(outcome.rtts.is_empty());
    }

    #[test]
    fn ignores_late_replies() {
        let targets = hosts(1);
        let mut transport = FakeTransport::new(&[(targets[0], Duration::from_millis(80))]);
        let outcome = sweep(&targets, &mut transport, fast(), &PAYLOAD).unwrap_or_default();
        assert!(outcome.rtts.is_empty());
    }

    #[test]
    fn ignores_foreign_malformed_and_mismatched_packets() {
        let targets = hosts(2);
        let mut transport = FakeTransport::new(&[]);
        let foreign = Ipv4Addr::new(10, 9, 0, 99);
        transport.extra.extend([
            (foreign, reply(ECHO_REPLY, 7, 0, &PAYLOAD)),
            (targets[0], vec![0, 0, 0]),
            (targets[0], reply(ECHO_REQUEST, 7, 0, &PAYLOAD)),
            (targets[0], reply(ECHO_REPLY, 7, 1, &PAYLOAD)),
            (targets[0], reply(ECHO_REPLY, 8, 0, &PAYLOAD)),
            (targets[0], reply(ECHO_REPLY, 7, 0, b"an earlier pass!")),
        ]);
        let outcome = sweep(&targets, &mut transport, fast(), &PAYLOAD).unwrap_or_default();
        assert!(outcome.rtts.is_empty());
        assert_eq!(outcome.ignored_packets, 6);
    }

    #[test]
    fn accepts_a_valid_reply_among_noise() {
        let targets = hosts(1);
        let mut transport = FakeTransport::new(&[]);
        transport.extra.extend([
            (targets[0], reply(ECHO_REPLY, 7, 9, &PAYLOAD)),
            (targets[0], reply(ECHO_REPLY, 7, 0, &PAYLOAD)),
        ]);
        let outcome = sweep(&targets, &mut transport, fast(), &PAYLOAD).unwrap_or_default();
        assert_eq!(outcome.rtts.len(), 1);
        assert_eq!(outcome.ignored_packets, 1);
    }

    #[test]
    fn a_reply_flood_cannot_extend_the_pass() {
        let targets = hosts(1);
        let mut transport = FakeTransport::new(&[]);
        let noise = (targets[0], reply(ECHO_REPLY, 7, 5, &PAYLOAD));
        transport.extra.extend(std::iter::repeat_n(noise, 10_000));
        let result = sweep(&targets, &mut transport, fast(), &PAYLOAD);
        assert!(matches!(result, Err(SweepError::ReadBudgetExhausted)));
        assert_eq!(transport.extra.len(), 10_000 - (4 + 64));
    }

    #[test]
    fn refusal_to_send_is_a_permission_error_not_an_empty_network() {
        let targets = hosts(3);
        let mut transport = FakeTransport::new(&[]);
        transport.send_error = Some(io::ErrorKind::PermissionDenied);
        let result = sweep(&targets, &mut transport, fast(), &PAYLOAD);
        assert!(matches!(result, Err(SweepError::NotPermitted(_))));
    }

    #[test]
    fn nothing_sent_is_an_error() {
        let targets = hosts(3);
        let mut transport = FakeTransport::new(&[]);
        transport.send_error = Some(io::ErrorKind::NetworkUnreachable);
        let result = sweep(&targets, &mut transport, fast(), &PAYLOAD);
        assert!(matches!(result, Err(SweepError::NothingSent)));
    }

    #[test]
    fn the_deadline_bounds_the_whole_pass() {
        let targets = hosts(40);
        let mut transport = FakeTransport::new(&[]);
        let limits = Limits {
            window: 2,
            reply_timeout: Duration::from_millis(50),
            deadline: Duration::from_millis(120),
        };
        let started = Instant::now();
        let result = sweep(&targets, &mut transport, limits, &PAYLOAD);
        assert!(matches!(result, Err(SweepError::Deadline)));
        assert!(started.elapsed() < Duration::from_millis(400));
        assert!(transport.sent.len() < targets.len());
    }

    #[test]
    fn staggered_requests_keep_the_window_full() {
        // Regression: expiring after refilling left freed slots idle until the next wake-up
        // once requests were in flight in two groups, halving the window (2026-11-17, Pi).
        let targets = hosts(24);
        let mut transport = FakeTransport::new(&[]);
        transport.stall = Some((2, Duration::from_millis(20)));
        let limits = Limits {
            window: 4,
            reply_timeout: Duration::from_millis(50),
            deadline: Duration::from_secs(5),
        };
        let started = Instant::now();
        let outcome = sweep(&targets, &mut transport, limits, &PAYLOAD).unwrap_or_default();
        // Six windows of 50 ms plus the stall; with idle slots it takes about 600 ms.
        let elapsed = started.elapsed();
        assert_eq!(outcome.sent, 24);
        assert!(elapsed < Duration::from_millis(450), "{elapsed:?}");
    }

    #[test]
    fn rejects_more_targets_than_sequence_numbers() {
        let targets = vec![Ipv4Addr::new(10, 0, 0, 1); MAX_TARGETS + 1];
        let mut transport = FakeTransport::new(&[]);
        let result = sweep(&targets, &mut transport, fast(), &PAYLOAD);
        assert!(matches!(result, Err(SweepError::TooManyTargets(_))));
    }
}
