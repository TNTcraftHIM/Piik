//! Measures the NAT in front of this machine and prints what the model reads from it.
//!
//! It asks a few public STUN servers which address they see, from two sockets and then from more
//! when the answers differ, one request at a time, and prints a report to copy. It sends nothing
//! else anywhere, and the report shows only half of the public address unless `--full` is given.
use piik_nat::mapping::{replay, Allocator, Cursor, Holdout, Model, Sample};
use piik_nat::stun;
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, ToSocketAddrs, UdpSocket};
use std::time::{Duration, Instant};

/// Observers reachable from most networks, the product's defaults first. Several answer on two
/// ports of one address, which shows whether a mapping follows the destination's port.
/// `stun.chat.bilibili.com:3479` is left out: in seven field surveys it alone reported an address
/// other than the one every other observer saw, the port being the same.
const OBSERVERS: [&str; 11] = [
    "stun.cloudflare.com:3478",
    "stun.miwifi.com:3478",
    "stun.chat.bilibili.com:3478",
    "stun.l.google.com:19302",
    "stun.cloudflare.com:53",
    "stun.l.google.com:3478",
    "stun.qq.com:3478",
    "stun.hitv.com:3478",
    "stun.douyucdn.cn:18000",
    "stun.miwifi.com:3479",
    "stun.douyucdn.cn:18001",
];
/// One answer is waited for this long, twice.
const ANSWER: Duration = Duration::from_millis(700);
/// Mappings made from new sockets when the first answers differ, to see the allocator at work.
const EXTRA_MAPPINGS: usize = 24;
/// A replay judges a mapping once this many were made before it, against the aims a peer allowed
/// each of these numbers of packets would be given.
const REPLAY_AFTER: usize = 8;
const REPLAY_PACKETS: [u16; 3] = [16, 64, 1024];

struct Survey {
    started: Instant,
    samples: Vec<Sample>,
    /// Requests that got no answer.
    unanswered: u32,
    /// The local port of each socket, by its number.
    local_ports: Vec<u16>,
}
impl Survey {
    fn socket(&mut self) -> Option<(UdpSocket, u16)> {
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
        self.local_ports.push(socket.local_addr().ok()?.port());
        Some((socket, (self.local_ports.len() - 1) as u16))
    }
    /// Asks `observer` from `socket`, waits for the answer and records it under `number`.
    fn ask(&mut self, socket: &UdpSocket, number: u16, observer: SocketAddrV4) -> Option<SocketAddrV4> {
        let sent_ms = self.started.elapsed().as_millis() as u32;
        let mut transaction = [0; 12];
        for chunk in transaction.chunks_mut(8) {
            chunk.copy_from_slice(&random().to_ne_bytes()[..chunk.len()]);
        }
        // The mapping exists once the request has left, so asking again reads the same one.
        let mapped = (0..2).find_map(|_| {
            socket.send_to(&stun::request(transaction), observer).ok()?;
            receive(socket, observer, transaction)
        });
        let Some(mapped) = mapped else {
            self.unanswered += 1;
            return None;
        };
        self.samples.push(Sample { socket: number, local_port: self.local_ports[usize::from(number)], observer, sent_ms, mapped });
        Some(mapped)
    }
}

fn receive(socket: &UdpSocket, observer: SocketAddrV4, transaction: [u8; 12]) -> Option<SocketAddrV4> {
    let deadline = Instant::now() + ANSWER;
    let mut packet = [0; 512];
    loop {
        // The socket waits only for what is left of the deadline, so a stray packet does not renew it.
        let left = deadline.checked_duration_since(Instant::now()).filter(|left| !left.is_zero())?;
        socket.set_read_timeout(Some(left)).ok()?;
        let Ok((length, source)) = socket.recv_from(&mut packet) else { return None };
        if source != SocketAddr::V4(observer) {
            continue;
        }
        if let Some(SocketAddr::V4(mapped)) = stun::mapped(&packet[..length], transaction) {
            return Some(mapped);
        }
    }
}

/// A random number from the standard library's hasher, which is keyed from the system's randomness.
fn random() -> u64 {
    RandomState::new().build_hasher().finish()
}

/// The numbers below `count` in a random order.
fn shuffled(count: usize) -> Vec<usize> {
    let mut order: Vec<usize> = (0..count).collect();
    for index in (1..count).rev() {
        order.swap(index, (random() % (index as u64 + 1)) as usize);
    }
    order
}

/// The address this machine would send from toward `target`; no packet is sent to learn it.
fn local_address(target: &str) -> Option<IpAddr> {
    let socket = UdpSocket::bind(if target.starts_with('[') { "[::]:0" } else { "0.0.0.0:0" }).ok()?;
    socket.connect(target).ok()?;
    Some(socket.local_addr().ok()?.ip())
}

const USAGE: &str = "usage: piik-nat-lab [--full]\n\nAsks public STUN servers which address they see for this machine and prints what that says\nabout the NAT in front of it. Nothing else is sent anywhere.\n\n  --full   show the whole public address in the report (it shows half by default)\n  --help   show this text";

fn main() {
    // Arguments are read before any name is resolved or any socket opened.
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.iter().any(|argument| argument == "--help" || argument == "-h") {
        return println!("{USAGE}");
    }
    if let Some(unknown) = arguments.iter().find(|argument| *argument != "--full") {
        eprintln!("unknown argument: {unknown}\n\n{USAGE}");
        std::process::exit(2);
    }
    let full = !arguments.is_empty();
    println!("piik-nat-lab {}: asking public STUN servers which address they see.", env!("CARGO_PKG_VERSION"));
    let mut survey = Survey { started: Instant::now(), samples: Vec::new(), unanswered: 0, local_ports: Vec::new() };
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
    addresses.sort();
    addresses.dedup();
    if addresses.len() < 2 {
        return println!("Fewer than two STUN servers answered ({}). UDP may be blocked on this network.", observers.len());
    }
    for index in shuffled(observers.len()) {
        survey.ask(&second, second_number, observers[index].1);
    }
    // Where a mapping depends on its destination, new sockets show the allocator at work: each
    // makes one mapping, toward the observers in turn.
    if !matches!(Model::read(&survey.samples), Ok(Model { allocator: Allocator::Point { .. }, .. })) {
        for index in 0..EXTRA_MAPPINGS {
            if let Some((socket, number)) = survey.socket() {
                survey.ask(&socket, number, observers[index % observers.len()].1);
            }
        }
    }
    report(&survey, &observers, first_number, full);
}

/// The cursors of an allocator in one line: each with its last port, its step and how many mappings landed on it.
fn cursors_line(cursors: &[Cursor]) -> String {
    let each: Vec<String> = cursors.iter().map(|cursor| format!("{} step {} x{} ({:.1}/s)", cursor.last, cursor.step, cursor.landings, cursor.per_second())).collect();
    format!("CURSORS. {} counter(s), next mapping one step past one of: {}", cursors.len(), each.join(", "))
}

/// What the answers that show one public address say, read by themselves.
fn read_address(samples: &[Sample], observers: &[(&str, SocketAddrV4)]) {
    match Model::read(samples).map(|model| model.allocator) {
        Err(unusable) => println!("model: unusable ({unusable:?})"),
        Ok(Allocator::Point { port, preserved }) => println!("model: POINT. One mapping per socket whatever the destination (port {port}); local port kept: {}", if preserved { "yes" } else { "no" }),
        Ok(Allocator::Cursors(cursors)) => println!("model: {}", cursors_line(&cursors)),
        Ok(Allocator::Drawn { low, high }) => println!("model: DRAWN. No port follows another; seen between {low} and {high}"),
    }
    // A socket that shows a port again is reading the mapping it already has.
    let mut made: Vec<Sample> = Vec::new();
    for sample in samples {
        if !made.iter().any(|earlier| earlier.socket == sample.socket && earlier.mapped == sample.mapped) {
            made.push(*sample);
        }
    }
    println!("mappings made: {}", made.len());
    // The cursors that the mappings toward each observer used: a peer is one more destination.
    for (index, (_, observer)) in observers.iter().enumerate() {
        let toward: Vec<(u32, u16)> = made.iter().filter(|sample| sample.observer == *observer).map(|sample| (sample.sent_ms, sample.mapped.port())).collect();
        if let Allocator::Cursors(cursors) = Allocator::of(&toward) {
            let each: Vec<String> = cursors.iter().take(6).map(|cursor| format!("{}x{}", cursor.last, cursor.landings)).collect();
            println!("toward observer {index}: {} mappings on {} cursor(s): {}", toward.len(), cursors.len(), each.join(" "));
        }
    }
    // The survey judged by itself: each mapping against the aim read from the mappings before it.
    for (reading, holdout) in [("all earlier mappings", Holdout::Nothing), ("other destinations", Holdout::Destination), ("other addresses", Holdout::Address)] {
        let each: Vec<String> = REPLAY_PACKETS
            .iter()
            .map(|&packets| {
                let replayed = replay(&made, REPLAY_AFTER, holdout, packets);
                format!("{packets} packets held {} of {}", replayed.held, replayed.held + replayed.missed + replayed.no_aim)
            })
            .collect();
        println!("replay reading {reading}: {}", each.join("; "));
    }
}

fn report(survey: &Survey, observers: &[(&str, SocketAddrV4)], first: u16, full: bool) {
    // Each public address seen gets a letter, in the order seen.
    let mut addresses: Vec<Ipv4Addr> = Vec::new();
    for sample in &survey.samples {
        if !addresses.contains(sample.mapped.ip()) {
            addresses.push(*sample.mapped.ip());
        }
    }
    let letter = |address: &Ipv4Addr| (b'A' + addresses.iter().position(|known| known == address).unwrap_or(25).min(25) as u8) as char;
    let shown = |address: Ipv4Addr| match full {
        true => address.to_string(),
        false => format!("{}.{}.x.x", address.octets()[0], address.octets()[1]),
    };
    let local = local_address("1.1.1.1:53");
    let network = match local {
        Some(IpAddr::V4(address)) if addresses.contains(&address) => "no NAT: this machine holds the public address",
        Some(IpAddr::V4(address)) if address.octets()[0] == 100 && address.octets()[1] & 0xc0 == 64 => "carrier address (100.64.0.0/10) on this machine",
        Some(IpAddr::V4(address)) if address.is_private() => "private address on this machine",
        Some(_) => "public address on this machine that differs from the one seen",
        None => "no IPv4 route",
    };
    let ipv6 = matches!(local_address("[2606:4700:4700::1111]:53"), Some(IpAddr::V6(address)) if address.segments()[0] & 0xe000 == 0x2000);
    println!("\n==== report (copy from here) ====");
    println!("tool: piik-nat-lab {}", env!("CARGO_PKG_VERSION"));
    println!("observers answered: {} of {}; requests answered {}, unanswered {}", observers.len(), OBSERVERS.len(), survey.samples.len(), survey.unanswered);
    println!("local: {network}; global IPv6: {}", if ipv6 { "yes" } else { "no" });
    println!("public addresses: {}", addresses.iter().map(|address| format!("{} {}", letter(address), shown(*address))).collect::<Vec<_>>().join(", "));
    // Whether the mapping follows the destination's port: the same socket, the same address, two ports.
    let seen = |observer: &SocketAddrV4| survey.samples.iter().find(|sample| sample.socket == first && sample.observer == *observer).map(|sample| sample.mapped);
    let by_port = observers.iter().enumerate().find_map(|(index, (_, one))| {
        let (_, other) = observers[index + 1..].iter().find(|(_, other)| other.ip() == one.ip())?;
        Some(seen(one)? != seen(other)?)
    });
    if let Some(by_port) = by_port {
        println!("same address, other port: {}", if by_port { "another mapping (depends on address and port)" } else { "the same mapping" });
    }
    if addresses.len() == 1 {
        read_address(&survey.samples, observers);
    } else {
        // One socket that shows two addresses was sent out by its destination; otherwise each
        // socket keeps to one way out.
        let by_destination = survey.samples.iter().any(|one| survey.samples.iter().any(|other| other.socket == one.socket && other.mapped.ip() != one.mapped.ip()));
        println!(
            "note: this machine's traffic left through {} public addresses, chosen by the {}. A carrier or a router with several lines does this, and so does a proxy or VPN that carries part of the traffic. Each address is read by itself.",
            addresses.len(),
            if by_destination { "destination" } else { "socket" }
        );
        for address in &addresses {
            let on_address: Vec<Sample> = survey.samples.iter().copied().filter(|sample| sample.mapped.ip() == address).collect();
            let mut toward: Vec<usize> = on_address.iter().filter_map(|sample| observers.iter().position(|(_, observer)| *observer == sample.observer)).collect();
            toward.sort();
            toward.dedup();
            println!("-- address {} {}: seen by observers {}", letter(address), shown(*address), toward.iter().map(usize::to_string).collect::<Vec<_>>().join(" "));
            read_address(&on_address, observers);
        }
    }
    println!("samples (socket, observer, ms, address, mapped port, local port):");
    for sample in &survey.samples {
        let observer = observers.iter().position(|(_, address)| *address == sample.observer).unwrap_or(99);
        println!("  {:>2} {:>2} {:>5} {} {:>5} {:>5}", sample.socket, observer, sample.sent_ms, letter(sample.mapped.ip()), sample.mapped.port(), survey.local_ports[usize::from(sample.socket)]);
    }
    println!("observers: {}", observers.iter().enumerate().map(|(index, (name, _))| format!("{index}={name}")).collect::<Vec<_>>().join(" "));
    println!("==== end of report ====");
}
