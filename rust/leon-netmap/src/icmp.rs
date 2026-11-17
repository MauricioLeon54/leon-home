//! Linux ICMP datagram ("ping") socket. Needs no capability: the kernel allows it to groups in
//! net.ipv4.ping_group_range, sets the echo identifier and checksum, delivers only echo replies
//! carrying this socket's identifier and strips the IP header. Raw sockets are never used.

use std::io;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::time::Duration;

use socket2::{Domain, Protocol, Socket, Type};

use crate::sweep::{ECHO_REQUEST, PAYLOAD_BYTES, Transport};

pub struct IcmpSocket {
    // A datagram socket of any protocol supports sendto/recvfrom; std's wrapper is enough once
    // socket2 has created it with IPPROTO_ICMP.
    socket: UdpSocket,
}

impl IcmpSocket {
    pub fn open() -> io::Result<Self> {
        let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::ICMPV4))?;
        Ok(IcmpSocket {
            socket: socket.into(),
        })
    }
}

impl Transport for IcmpSocket {
    fn send(
        &mut self,
        to: Ipv4Addr,
        sequence: u16,
        payload: &[u8; PAYLOAD_BYTES],
    ) -> io::Result<()> {
        let mut packet = [0u8; 8 + PAYLOAD_BYTES];
        packet[0] = ECHO_REQUEST;
        packet[6..8].copy_from_slice(&sequence.to_be_bytes());
        packet[8..].copy_from_slice(payload);
        self.socket
            .send_to(&packet, SocketAddrV4::new(to, 0))
            .map(|_| ())
    }

    fn identifier(&self) -> Option<u16> {
        self.socket.local_addr().ok().map(|address| address.port())
    }

    fn receive(
        &mut self,
        buffer: &mut [u8],
        timeout: Duration,
    ) -> io::Result<Option<(Ipv4Addr, usize)>> {
        self.socket
            .set_read_timeout(Some(timeout.max(Duration::from_millis(1))))?;
        match self.socket.recv_from(buffer) {
            Ok((length, SocketAddr::V4(source))) => Ok(Some((*source.ip(), length))),
            Ok((_, SocketAddr::V6(_))) => Ok(None),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }
}
