//! Real Linux ICMP datagram sockets against loopback only (127.0.0.0/8 answers locally; no
//! packet leaves the host). Runs in the Linux development container; skipped elsewhere.
#![cfg(target_os = "linux")]

use std::net::Ipv4Addr;
use std::time::Duration;

use leon_netmap::icmp::IcmpSocket;
use leon_netmap::sweep::{self, Limits, Transport};

const PAYLOAD: [u8; 16] = *b"linux-icmp-test!";

fn limits() -> Limits {
    Limits {
        window: 4,
        reply_timeout: Duration::from_millis(500),
        deadline: Duration::from_secs(5),
    }
}

#[test]
fn loopback_targets_answer_through_a_datagram_socket() -> std::io::Result<()> {
    // On Linux these are required integration checks: missing permissions must fail the test.
    let mut socket = IcmpSocket::open()?;
    let targets: Vec<Ipv4Addr> = (1..=6).map(|n| Ipv4Addr::new(127, 0, 0, n)).collect();
    let outcome = sweep::sweep(&targets, &mut socket, limits(), &PAYLOAD);
    let Ok(outcome) = outcome else {
        unreachable!("sweep failed: {outcome:?}");
    };
    assert_eq!(outcome.sent, 6);
    assert_eq!(outcome.rtts.len(), 6, "{outcome:?}");
    assert!(outcome.rtts.values().all(|rtt| (0.0..500.0).contains(rtt)));
    // The kernel bound an identifier on the first send.
    assert!(socket.identifier().is_some());
    Ok(())
}

#[test]
fn a_second_socket_does_not_see_the_first_sockets_replies() -> std::io::Result<()> {
    let (mut first, mut second) = (IcmpSocket::open()?, IcmpSocket::open()?);
    let target = Ipv4Addr::LOCALHOST;
    assert!(first.send(target, 0, &PAYLOAD).is_ok());
    let mut buffer = [0u8; 512];
    // The second socket's own identifier is bound by its send; it answers from 127.0.0.9.
    assert!(
        second
            .send(Ipv4Addr::new(127, 0, 0, 9), 0, &PAYLOAD)
            .is_ok()
    );
    let mut from_target = 0;
    while let Ok(Some((source, _))) = second.receive(&mut buffer, Duration::from_millis(200)) {
        from_target += usize::from(source == target);
    }
    assert_eq!(from_target, 0);
    let received = first.receive(&mut buffer, Duration::from_millis(500));
    assert!(matches!(received, Ok(Some((source, _))) if source == target));
    Ok(())
}
