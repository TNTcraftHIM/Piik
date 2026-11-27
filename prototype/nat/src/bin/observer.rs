//! The answering side of a survey, for a server of our own: STUN Binding on a run of UDP ports.
//!
//!   piik-nat-observer <first port> <count> [address to bind]
//!
//! Each port answers a Binding request with the address it saw. Asked to answer from another
//! port, it answers from the next port of the run; it has one address, so a request to answer
//! from another address gets no answer. It keeps nothing and prints nothing about who asked.
use piik_nat::stun;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::sync::Arc;

const USAGE: &str = "usage: piik-nat-observer <first port> <count> [address to bind]";

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let parsed = (|| {
        let first: u16 = arguments.first()?.parse().ok()?;
        let count: u16 = arguments.get(1)?.parse().ok().filter(|count| *count >= 2)?;
        let address: Ipv4Addr = arguments.get(2).map_or(Some(Ipv4Addr::UNSPECIFIED), |text| text.parse().ok())?;
        first.checked_add(count - 1)?;
        Some((first, count, address))
    })();
    let Some((first, count, address)) = parsed else {
        eprintln!("{USAGE}");
        std::process::exit(2);
    };
    let sockets: Vec<UdpSocket> = (0..count)
        .map(|index| {
            UdpSocket::bind((address, first + index)).unwrap_or_else(|error| {
                eprintln!("cannot bind {address}:{}: {error}", first + index);
                std::process::exit(1);
            })
        })
        .collect();
    let sockets = Arc::new(sockets);
    println!("piik-nat-observer {}: answering on {address}:{first} to {}", env!("CARGO_PKG_VERSION"), first + count - 1);
    let workers: Vec<_> = (0..sockets.len())
        .map(|index| {
            let sockets = Arc::clone(&sockets);
            std::thread::spawn(move || serve(&sockets, index, SocketAddrV4::new(address, first + ((index + 1) % sockets.len()) as u16)))
        })
        .collect();
    for worker in workers {
        let _ = worker.join();
    }
}

/// Answers on one port for good. `other` is the port that answers when another port is asked for.
fn serve(sockets: &[UdpSocket], index: usize, other: SocketAddrV4) {
    let mut packet = [0; 64];
    loop {
        let Ok((length, SocketAddr::V4(source))) = sockets[index].recv_from(&mut packet) else { continue };
        let Some(asked) = stun::asked(&packet[..length]) else { continue };
        if asked.from_other_address {
            continue;
        }
        let from = if asked.from_other_port { &sockets[(index + 1) % sockets.len()] } else { &sockets[index] };
        let _ = from.send_to(&stun::success(asked.transaction, source, Some(other)), source);
    }
}
