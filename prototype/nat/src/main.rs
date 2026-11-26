//! Measures the NAT in front of this machine and prints what the model reads from it.
//!
//! It asks a few public STUN servers which address they see, from two sockets and then from more
//! when the answers differ, and prints a report to copy. It sends nothing else anywhere, and the
//! report shows only half of the public address unless `--full` is given.
use piik_nat::mapping::{measured, Allocator, Model, PortSet, Sample};
use piik_nat::stun;
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, ToSocketAddrs, UdpSocket};
use std::time::{Duration, Instant};

/// Observers reachable from most networks, the product's defaults first. One appears on two ports
/// to show whether a mapping depends on the destination's port as well as its address.
const OBSERVERS: [&str; 7] = [
    "stun.cloudflare.com:3478",
    "stun.miwifi.com:3478",
    "stun.chat.bilibili.com:3478",
    "stun.l.google.com:19302",
    "stun.cloudflare.com:53",
    "stun.l.google.com:3478",
    "stun.qq.com:3478",
];
/// One answer is waited for this long, twice.
const ANSWER: Duration = Duration::from_millis(700);
/// Mappings made from fresh sockets when the first answers differ, to see the allocator at work.
const EXTRA_MAPPINGS: usize = 10;
/// Measurements of one mapping between two observations.
const BRACKETS: usize = 5;

struct Survey {
    started: Instant,
    samples: Vec<Sample>,
    /// The local port of each socket, by its number.
    local_ports: Vec<u16>,
}
impl Survey {
    /// Asks `observer` from `socket` and records the answer under `number`.
    fn ask(&mut self, socket: &UdpSocket, number: u8, observer: SocketAddrV4) -> Option<SocketAddrV4> {
        let sent_ms = self.started.elapsed().as_millis() as u32;
        let transaction = send(socket, observer)?;
        let mapped = receive(socket, observer, transaction).or_else(|| {
            socket.send_to(&stun::request(transaction), observer).ok()?;
            receive(socket, observer, transaction)
        })?;
        self.samples.push(Sample { socket: number, observer, sent_ms, mapped });
        Some(mapped)
    }
    fn socket(&mut self) -> Option<(UdpSocket, u8)> {
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
        socket.set_read_timeout(Some(ANSWER)).ok()?;
        self.local_ports.push(socket.local_addr().ok()?.port());
        Some((socket, (self.local_ports.len() - 1) as u8))
    }
}

fn send(socket: &UdpSocket, observer: SocketAddrV4) -> Option<[u8; 12]> {
    let mut transaction = [0; 12];
    for chunk in transaction.chunks_mut(8) {
        // The standard library's hasher is keyed from the system's randomness.
        chunk.copy_from_slice(&RandomState::new().build_hasher().finish().to_ne_bytes()[..chunk.len()]);
    }
    socket.send_to(&stun::request(transaction), observer).ok()?;
    Some(transaction)
}

fn receive(socket: &UdpSocket, observer: SocketAddrV4, transaction: [u8; 12]) -> Option<SocketAddrV4> {
    let deadline = Instant::now() + ANSWER;
    let mut packet = [0; 512];
    while Instant::now() < deadline {
        let Ok((length, source)) = socket.recv_from(&mut packet) else { return None };
        if source != SocketAddr::V4(observer) {
            continue;
        }
        if let Some(SocketAddr::V4(mapped)) = stun::mapped(&packet[..length], transaction) {
            return Some(mapped);
        }
    }
    None
}

/// The address this machine would send from toward `target`; no packet is sent to learn it.
fn local_address(target: &str) -> Option<IpAddr> {
    let socket = UdpSocket::bind(if target.starts_with('[') { "[::]:0" } else { "0.0.0.0:0" }).ok()?;
    socket.connect(target).ok()?;
    Some(socket.local_addr().ok()?.ip())
}

fn main() {
    let full = std::env::args().any(|argument| argument == "--full");
    println!("piik-nat-lab {}: asking public STUN servers which address they see.", env!("CARGO_PKG_VERSION"));
    let mut survey = Survey { started: Instant::now(), samples: Vec::new(), local_ports: Vec::new() };
    let (Some((first, first_number)), Some((second, second_number))) = (survey.socket(), survey.socket()) else {
        return println!("Could not open a UDP socket.");
    };
    // Each observer that resolves and answers the first socket takes part.
    let mut observers: Vec<(&str, SocketAddrV4)> = Vec::new();
    for name in OBSERVERS {
        let address = name.to_socket_addrs().ok().and_then(|mut found| {
            found.find_map(|address| match address {
                SocketAddr::V4(address) => Some(address),
                SocketAddr::V6(_) => None,
            })
        });
        let Some(address) = address.filter(|address| observers.iter().all(|(_, known)| known != address)) else { continue };
        if survey.ask(&first, first_number, address).is_some() {
            observers.push((name, address));
        }
    }
    let mut addresses: Vec<Ipv4Addr> = observers.iter().map(|(_, address)| *address.ip()).collect();
    addresses.dedup();
    addresses.sort();
    addresses.dedup();
    if addresses.len() < 2 {
        return println!("Fewer than two STUN servers answered ({}). UDP may be blocked on this network.", observers.len());
    }
    for (_, address) in &observers {
        survey.ask(&second, second_number, *address);
    }
    let dependent = !matches!(Model::read(&survey.samples), Ok(Model { allocator: Allocator::Point { .. }, .. }));
    // Whether the mapping follows the destination's port: the same socket, the same address, two ports.
    let by_port = observers.iter().enumerate().find_map(|(index, (_, one))| {
        let (_, other) = observers[index + 1..].iter().find(|(_, other)| other.ip() == one.ip())?;
        let seen = |observer: &SocketAddrV4| {
            survey.samples.iter().find(|sample| sample.socket == first_number && sample.observer == *observer).map(|sample| sample.mapped)
        };
        Some(seen(one)? != seen(other)?)
    });
    let mut brackets = Vec::new();
    let mut burst = Vec::new();
    if dependent {
        for index in 0..EXTRA_MAPPINGS {
            if let Some((socket, number)) = survey.socket() {
                survey.ask(&socket, number, observers[index % observers.len()].1);
            }
        }
        if let Ok(Model { allocator: Allocator::Counter { step, .. }, .. }) = Model::read(&survey.samples) {
            // A mapping made between two observations, all three sent without waiting.
            for _ in 0..BRACKETS {
                let sockets: Vec<UdpSocket> = (0..3).filter_map(|_| survey.socket().map(|(socket, _)| socket)).collect();
                if sockets.len() < 3 {
                    break;
                }
                let sent: Vec<_> = sockets.iter().enumerate().map(|(index, socket)| send(socket, observers[index % observers.len()].1)).collect();
                let ports: Vec<Option<u16>> = sockets
                    .iter()
                    .enumerate()
                    .map(|(index, socket)| receive(socket, observers[index % observers.len()].1, sent[index]?).map(|mapped| mapped.port()))
                    .collect();
                if let [Some(before), Some(between), Some(after)] = ports[..] {
                    brackets.push((before, between, after, measured(before, after, step) == Some(between)));
                }
            }
            // Eight mappings in one burst: how often other traffic falls between them.
            let sockets: Vec<UdpSocket> = (0..8).filter_map(|_| survey.socket().map(|(socket, _)| socket)).collect();
            let sent: Vec<_> = sockets.iter().map(|socket| send(socket, observers[0].1)).collect();
            burst = sockets.iter().zip(sent).filter_map(|(socket, sent)| Some(receive(socket, observers[0].1, sent?)?.port())).collect();
        }
    }
    report(&survey, &observers, first_number, second_number, by_port, &brackets, &burst, full);
}

#[allow(clippy::too_many_arguments)]
fn report(
    survey: &Survey, observers: &[(&str, SocketAddrV4)], first: u8, second: u8, by_port: Option<bool>,
    brackets: &[(u16, u16, u16, bool)], burst: &[u16], full: bool,
) {
    let model = Model::read(&survey.samples);
    let public = *survey.samples[0].mapped.ip();
    let shown = |address: Ipv4Addr| match full {
        true => address.to_string(),
        false => format!("{}.{}.x.x", address.octets()[0], address.octets()[1]),
    };
    let local = local_address("1.1.1.1:53");
    let network = match local {
        Some(IpAddr::V4(address)) if address == public => "no NAT: this machine holds the public address",
        Some(IpAddr::V4(address)) if address.octets()[0] == 100 && address.octets()[1] & 0xc0 == 64 => "carrier address (100.64.0.0/10) on this machine",
        Some(IpAddr::V4(address)) if address.is_private() => "private address on this machine",
        Some(_) => "public address on this machine that differs from the one seen",
        None => "no IPv4 route",
    };
    let ipv6 = matches!(local_address("[2606:4700:4700::1111]:53"), Some(IpAddr::V6(address)) if address.segments()[0] & 0xe000 == 0x2000);
    println!("\n==== report (copy from here) ====");
    println!("observers answered: {} of {} ({} addresses)", observers.len(), OBSERVERS.len(), {
        let mut addresses: Vec<_> = observers.iter().map(|(_, address)| address.ip()).collect();
        addresses.sort();
        addresses.dedup();
        addresses.len()
    });
    println!("local: {network}; global IPv6: {}", if ipv6 { "yes" } else { "no" });
    println!("public address: {}", shown(public));
    match &model {
        Err(unusable) => println!("model: unusable ({unusable:?})"),
        Ok(model) => match model.allocator {
            Allocator::Point { port } => {
                let preserved = [first, second].iter().all(|number| {
                    survey.samples.iter().filter(|sample| sample.socket == *number).all(|sample| sample.mapped.port() == survey.local_ports[usize::from(*number)])
                });
                println!("model: POINT. One mapping per socket whatever the destination (port {port}); local port kept: {}", if preserved { "yes" } else { "no" });
            }
            Allocator::Counter { last, step, foreign_per_ks, .. } => println!(
                "model: COUNTER. Step {step}, last port {last}, other traffic about {:.1} mappings a second", f64::from(foreign_per_ks) / 1000.0
            ),
            Allocator::Set(PortSet::Span { low, high }) => println!("model: SET. Ports seen between {low} and {high} ({} ports)", u32::from(high) - u32::from(low) + 1),
            Allocator::Set(set @ PortSet::Shared { offset, length, psid }) => {
                println!("model: PORT SET (RFC 7597). Offset {offset}, length {length}, identifier {psid}: {} ports", set.size())
            }
        },
    }
    if let Some(by_port) = by_port {
        println!("same address, other port: {}", if by_port { "another mapping (depends on address and port)" } else { "the same mapping" });
    }
    if !brackets.is_empty() {
        let exact = brackets.iter().filter(|bracket| bracket.3).count();
        println!("measured between two observations: {exact} of {} exact {:?}", brackets.len(), brackets.iter().map(|b| (b.0, b.1, b.2)).collect::<Vec<_>>());
    }
    if !burst.is_empty() {
        println!("burst of {}: {burst:?}", burst.len());
    }
    // Each public address seen gets a letter, and the mappings made on it are read on their own.
    let mut addresses: Vec<Ipv4Addr> = Vec::new();
    for sample in &survey.samples {
        if !addresses.contains(sample.mapped.ip()) {
            addresses.push(*sample.mapped.ip());
        }
    }
    let letter = |address: &Ipv4Addr| (b'A' + addresses.iter().position(|known| known == address).unwrap_or(25).min(25) as u8) as char;
    if addresses.len() > 1 {
        println!("public addresses seen: {}", addresses.len());
        for address in &addresses {
            let mut allocations: Vec<(u32, u16)> = Vec::new();
            for sample in survey.samples.iter().filter(|sample| sample.mapped.ip() == address) {
                if !allocations.iter().any(|&(_, port)| port == sample.mapped.port()) {
                    allocations.push((sample.sent_ms, sample.mapped.port()));
                }
            }
            println!("  {} {}: {} mappings, {:?}", letter(address), shown(*address), allocations.len(), Allocator::of(&allocations));
        }
    }
    println!("samples (socket, observer, ms, address, mapped port, local port):");
    for sample in &survey.samples {
        let observer = observers.iter().position(|(_, address)| *address == sample.observer).unwrap_or(99);
        println!(
            "  {:>2} {:>2} {:>5} {} {:>5} {:>5}",
            sample.socket, observer, sample.sent_ms, letter(sample.mapped.ip()), sample.mapped.port(), survey.local_ports[usize::from(sample.socket)]
        );
    }
    println!("observers: {}", observers.iter().enumerate().map(|(index, (name, _))| format!("{index}={name}")).collect::<Vec<_>>().join(" "));
    println!("==== end of report ====");
}
