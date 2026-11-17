//! LEÓN Home network inventory pass: the Rust engine behind leon-netmap.service. It keeps
//! netmap.py's contract (scope, bounds, state document, retention) and replaces its `ping`
//! children with one unprivileged ICMP datagram socket. See docs/NETMAP-ENGINE.md.

pub mod icmp;
pub mod state;
pub mod sweep;
pub mod system;
