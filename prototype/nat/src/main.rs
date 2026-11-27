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
const OBSERVERS: [&str; 19] = [
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
    // Four more hosts on the two ports of the first: where each destination has its own
    // counter, they show whether it follows the destination's address, its port, or both.
    "stun1.l.google.com:19302",
    "stun1.l.google.com:3478",
    "stun2.l.google.com:19302",
    "stun2.l.google.com:3478",
    "stun3.l.google.com:19302",
    "stun3.l.google.com:3478",
    "stun4.l.google.com:19302",
    "stun4.l.google.com:3478",
];
/// One answer is waited for this long, twice.
const ANSWER: Duration = Duration::from_millis(700);
/// Mappings made from new sockets when the first answers differ, to see the allocator at work.
const EXTRA_MAPPINGS: usize = 24;
/// A replay judges a mapping once this many were made before it, against the aims a peer allowed
/// each of these numbers of packets would be given.
const REPLAY_AFTER: usize = 8;
const REPLAY_PACKETS: [u16; 3] = [16, 64, 1024];
/// Brackets tried where mappings come from an allocator at work.
const BRACKETS: usize = 12;

struct Survey {
    answered: u32,
    bracket_attempts: usize,
    addresses: Vec<Ipv4Addr>,
    started: Instant,
    samples: Vec<Sample>,
    /// Requests that got no answer.
    unanswered: u32,
    /// The local port of each socket, by its number.
    local_ports: Vec<u16>,
    /// The answers of each bracket: first, middle, last.
    brackets: Vec<[Sample; 3]>,
    /// For each observer that can answer from elsewhere: whether its answer from another address
    /// and port came in, and whether its answer from another port of the same address did.
    filtering: Vec<(SocketAddrV4, bool, bool)>,
}
impl Survey {
    fn record_answer(&mut self, mapped: SocketAddrV4) {
        self.answered += 1;
        if !self.addresses.contains(mapped.ip()) {
            self.addresses.push(*mapped.ip());
        }
    }

    fn socket(&mut self) -> Option<(UdpSocket, u16)> {
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
        self.local_ports.push(socket.local_addr().ok()?.port());
        Some((socket, (self.local_ports.len() - 1) as u16))
    }
    /// Asks `observer` from `socket`, waits for the answer and records it under `number`.
    fn ask(&mut self, socket: &UdpSocket, number: u16, observer: SocketAddrV4) -> Option<SocketAddrV4> {
        let sent_ms = self.started.elapsed().as_millis() as u32;
        let transaction = transaction();
        // The mapping exists once the request has left, so asking again reads the same one.
        let answer = (0..2).find_map(|_| {
            socket.send_to(&stun::request(transaction), observer).ok()?;
            receive(socket, observer, transaction)
        });
        let Some((mapped, _)) = answer else {
            self.unanswered += 1;
            return None;
        };
        self.record_answer(mapped);
        self.samples.push(Sample { socket: number, local_port: self.local_ports[usize::from(number)], observer, sent_ms, mapped });
        Some(mapped)
    }
    /// Tests the two advertised reply sources from a socket that sends only to `observer`.
    fn filtering(&mut self, observer: SocketAddrV4) -> Option<(bool, bool)> {
        let (socket, _) = self.socket()?;
        let first = transaction();
        socket.send_to(&stun::request(first), observer).ok()?;
        let (_, Some(SocketAddr::V4(elsewhere))) = receive(&socket, observer, first)? else { return None };
        if elsewhere.ip() == observer.ip() || elsewhere.port() == observer.port() || elsewhere.port() == 0 || elsewhere.ip().is_unspecified() {
            return None;
        }
        let answered = |change_ip: bool, expected| {
            let transaction = transaction();
            let request = stun::request_from_elsewhere(transaction, change_ip, true);
            (0..2).any(|_| socket.send_to(&request, observer).is_ok() && receive(&socket, expected, transaction).is_some())
        };
        let other_port = SocketAddrV4::new(*observer.ip(), elsewhere.port());
        let outcome = (answered(true, elsewhere), answered(false, other_port));
        self.filtering.push((observer, outcome.0, outcome.1));
        Some(outcome)
    }
    /// Sends from three new sockets in a row, the outer two to `outer` and the middle one to
    /// `middle`, and only then reads the answers. Where a NAT takes ports from a counter, the
    /// middle mapping lies between the outer two however fast other traffic moves the counter:
    /// that is what a peer could be told in place of a guess.
    fn bracket(&mut self, outer: SocketAddrV4, middle: SocketAddrV4) -> Option<[Sample; 3]> {
        self.bracket_attempts += 1;
        let mut asked = Vec::with_capacity(3);
        for observer in [outer, middle, outer] {
            let (socket, number) = self.socket()?;
            asked.push((socket, number, observer, transaction()));
        }
        let sent_ms = self.started.elapsed().as_millis() as u32;
        for (socket, _, observer, transaction) in &asked {
            socket.send_to(&stun::request(*transaction), observer).ok()?;
        }
        let mut answers = Vec::with_capacity(3);
        for (socket, number, observer, transaction) in &asked {
            let Some((mapped, _)) = receive(socket, *observer, *transaction) else {
                self.unanswered += 1;
                continue;
            };
            self.record_answer(mapped);
            answers.push(Sample { socket: *number, local_port: self.local_ports[usize::from(*number)], observer: *observer, sent_ms, mapped });
        }
        let bracket: [Sample; 3] = answers.try_into().ok()?;
        self.brackets.push(bracket);
        Some(bracket)
    }
}

/// A transaction identifier nobody else can guess.
fn transaction() -> [u8; 12] {
    let mut transaction = [0; 12];
    for chunk in transaction.chunks_mut(8) {
        chunk.copy_from_slice(&random().to_ne_bytes()[..chunk.len()]);
    }
    transaction
}

/// The answer to `transaction`: the address it reports and the other address its server names.
/// Only a reply from the expected IP and port qualifies.
fn receive(socket: &UdpSocket, from: SocketAddrV4, transaction: [u8; 12]) -> Option<(SocketAddrV4, Option<SocketAddr>)> {
    let deadline = Instant::now() + ANSWER;
    let mut packet = [0; 512];
    loop {
        // The socket waits only for what is left of the deadline, so a stray packet does not renew it.
        let left = deadline.checked_duration_since(Instant::now()).filter(|left| !left.is_zero())?;
        socket.set_read_timeout(Some(left)).ok()?;
        let Ok((length, source)) = socket.recv_from(&mut packet) else { return None };
        if source != SocketAddr::V4(from) {
            continue;
        }
        if let Some(stun::Answer { mapped: SocketAddr::V4(mapped), elsewhere }) = stun::answer(&packet[..length], transaction) {
            return Some((mapped, elsewhere));
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
    let mut survey = Survey { answered: 0, bracket_attempts: 0, addresses: Vec::new(), started: Instant::now(), samples: Vec::new(), unanswered: 0, local_ports: Vec::new(), brackets: Vec::new(), filtering: Vec::new() };
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
        for index in 0..EXTRA_MAPPINGS.max(observers.len()) {
            if let Some((socket, number)) = survey.socket() {
                survey.ask(&socket, number, observers[index % observers.len()].1);
            }
        }
        // A bracket's two observers are different hosts that saw one public address from the
        // first socket, so the three mappings are made on one way out.
        let seen: Vec<(SocketAddrV4, Ipv4Addr)> = observers
            .iter()
            .filter_map(|(_, observer)| survey.samples.iter().find(|sample| sample.socket == first_number && sample.observer == *observer).map(|sample| (*observer, *sample.mapped.ip())))
            .collect();
        for round in 0..BRACKETS {
            let (outer, public) = seen[round % seen.len()];
            let mut others = seen.iter().cycle().skip(round % seen.len() + 1).take(seen.len());
            if let Some((middle, _)) = others.find(|(other, address)| *address == public && other.ip() != outer.ip()) {
                survey.bracket(outer, *middle);
            }
        }
    }
    for (_, observer) in &observers {
        survey.filtering(*observer);
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
                format!("{packets} packets held {} of {} ({} warm-up)", replayed.held, replayed.held + replayed.missed + replayed.no_aim, replayed.too_early)
            })
            .collect();
        println!("replay reading {reading}: {}", each.join("; "));
    }
}

fn report(survey: &Survey, observers: &[(&str, SocketAddrV4)], first: u16, full: bool) {
    // Each public address seen gets a letter, in the order seen.
    let addresses = &survey.addresses;
    let letter = |address: &Ipv4Addr| {
        let index = addresses.iter().position(|known| known == address).expect("recorded answer");
        if index < 26 { ((b'A' + index as u8) as char).to_string() } else { format!("A{}", index + 1) }
    };
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
    println!("observers answered: {} of {}; requests answered {}, unanswered {}", observers.len(), OBSERVERS.len(), survey.answered, survey.unanswered);
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
            "note: {} public addresses observed, chosen by the {}. A carrier or a router with several lines does this, and so does a proxy or VPN that carries part of the traffic. Each replay assumes the target's public address is known.",
            addresses.len(),
            if by_destination { "destination" } else { "socket" }
        );
        for address in addresses {
            let on_address: Vec<Sample> = survey.samples.iter().copied().filter(|sample| sample.mapped.ip() == address).collect();
            if on_address.is_empty() {
                println!("-- address {} {}: seen only in brackets", letter(address), shown(*address));
                continue;
            }
            let mut toward: Vec<usize> = on_address.iter().filter_map(|sample| observers.iter().position(|(_, observer)| *observer == sample.observer)).collect();
            toward.sort();
            toward.dedup();
            println!("-- address {} {}: seen by observers {}", letter(address), shown(*address), toward.iter().map(usize::to_string).collect::<Vec<_>>().join(" "));
            read_address(&on_address, observers);
        }
    }
    if survey.filtering.is_empty() {
        println!("filtering: not measured, no usable alternate address and port received");
    } else {
        println!("filtering: replies observed on this run");
        let observed = |received| if received { "reply observed" } else { "no qualifying reply" };
        for (observer, address, port) in &survey.filtering {
            let index = observers.iter().position(|(_, known)| known == observer).unwrap_or(99);
            println!("  observer {index}: alternate IP and port: {}; original IP and alternate port: {}", observed(*address), observed(*port));
        }
    }
    if survey.bracket_attempts > 0 {
        let (mut held, mut widths, mut crossed) = (0, Vec::new(), 0);
        for [first, middle, last] in &survey.brackets {
            if first.mapped.ip() != middle.mapped.ip() || last.mapped.ip() != middle.mapped.ip() {
                crossed += 1;
                continue;
            }
            let (low, high) = (first.mapped.port().min(last.mapped.port()), first.mapped.port().max(last.mapped.port()));
            widths.push(high - low);
            held += u32::from(low < middle.mapped.port() && middle.mapped.port() < high);
        }
        widths.sort();
        println!(
            "brackets: {} attempted, {} incomplete, {crossed} crossed exits, {} complete on one exit, {held} held between the outer ports",
            survey.bracket_attempts, survey.bracket_attempts - survey.brackets.len(), widths.len()
        );
        if let (Some(low), Some(high)) = (widths.first(), widths.last()) {
            println!("same-exit outer port separation: {low} to {high}, median {}", widths[widths.len() / 2]);
        }
        if !survey.brackets.is_empty() {
            println!("bracket samples (outer observer, middle observer, ms, then address and port of first, middle, last):");
        }
        for [first, middle, last] in &survey.brackets {
            let index = |sample: &Sample| observers.iter().position(|(_, address)| *address == sample.observer).unwrap_or(99);
            println!(
                "  {:>2} {:>2} {:>5}  {} {:>5}  {} {:>5}  {} {:>5}",
                index(first),
                index(middle),
                first.sent_ms,
                letter(first.mapped.ip()),
                first.mapped.port(),
                letter(middle.mapped.ip()),
                middle.mapped.port(),
                letter(last.mapped.ip()),
                last.mapped.port()
            );
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A STUN server on the loopback that answers `answers` requests with the address it saw.
    fn observer(host: Ipv4Addr, answers: usize) -> SocketAddrV4 {
        let socket = UdpSocket::bind((host, 0)).unwrap();
        let SocketAddr::V4(address) = socket.local_addr().unwrap() else { unreachable!() };
        std::thread::spawn(move || {
            let mut packet = [0; 64];
            for _ in 0..answers {
                let Ok((_, SocketAddr::V4(source))) = socket.recv_from(&mut packet) else { return };
                let mut answer = vec![0x01, 0x01, 0, 12];
                answer.extend_from_slice(&packet[4..20]);
                answer.extend_from_slice(&[0x00, 0x20, 0, 8, 0, 0x01]);
                answer.extend(source.port().to_be_bytes().iter().zip(&packet[4..6]).map(|(byte, mask)| byte ^ mask));
                answer.extend(source.ip().octets().iter().zip(&packet[4..8]).map(|(byte, mask)| byte ^ mask));
                socket.send_to(&answer, source).unwrap();
            }
        });
        address
    }

    #[test]
    fn a_bracket_is_three_sockets_whose_answers_are_read_after_all_three_have_sent() {
        let (outer, middle) = (observer(Ipv4Addr::new(127, 0, 0, 1), 2), observer(Ipv4Addr::new(127, 0, 0, 2), 1));
        let mut survey = Survey { answered: 0, bracket_attempts: 0, addresses: Vec::new(), started: Instant::now(), samples: Vec::new(), unanswered: 0, local_ports: Vec::new(), brackets: Vec::new(), filtering: Vec::new() };
        let [first, between, last] = survey.bracket(outer, middle).expect("three answers");
        assert_eq!([first.observer, between.observer, last.observer], [outer, middle, outer]);
        // No NAT on the loopback: each answer shows its own socket's port.
        for sample in [first, between, last] {
            assert_eq!(sample.mapped.port(), sample.local_port);
        }
        assert_eq!((survey.bracket_attempts, survey.brackets.len(), survey.answered, survey.unanswered), (1, 1, 3, 0));

        let silent = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let SocketAddr::V4(silent_address) = silent.local_addr().unwrap() else { unreachable!() };
        assert!(survey.bracket(observer(Ipv4Addr::LOCALHOST, 2), silent_address).is_none());
        assert_eq!((survey.bracket_attempts, survey.brackets.len(), survey.answered, survey.unanswered), (2, 1, 5, 1));
    }

    /// A STUN server on the loopback with a second address: it names it in each answer, and
    /// answers from it, or from another port of its own, when asked to.
    fn observer_with_another_address(honors_change: bool) -> SocketAddrV4 {
        let bind = |host: [u8; 4]| UdpSocket::bind((Ipv4Addr::from(host), 0)).unwrap();
        let (main, other_port) = (bind([127, 0, 0, 1]), bind([127, 0, 0, 1]));
        let other_address = UdpSocket::bind((Ipv4Addr::new(127, 0, 0, 2), other_port.local_addr().unwrap().port())).unwrap();
        let SocketAddr::V4(address) = main.local_addr().unwrap() else { unreachable!() };
        let SocketAddr::V4(elsewhere) = other_address.local_addr().unwrap() else { unreachable!() };
        std::thread::spawn(move || {
            let mut packet = [0; 64];
            let requests = if honors_change { 3 } else { 5 };
            for _ in 0..requests {
                let Ok((length, SocketAddr::V4(source))) = main.recv_from(&mut packet) else { return };
                let mut answer = vec![0x01, 0x01, 0, 24];
                answer.extend_from_slice(&packet[4..20]);
                answer.extend_from_slice(&[0x00, 0x20, 0, 8, 0, 0x01]);
                answer.extend(source.port().to_be_bytes().iter().zip(&packet[4..6]).map(|(byte, mask)| byte ^ mask));
                answer.extend(source.ip().octets().iter().zip(&packet[4..8]).map(|(byte, mask)| byte ^ mask));
                answer.extend_from_slice(&[0x80, 0x2c, 0, 8, 0, 0x01]);
                answer.extend(elsewhere.port().to_be_bytes());
                answer.extend(elsewhere.ip().octets());
                // The flags of a CHANGE-REQUEST, when the request carries one.
                let from = match (length == 28 && honors_change).then(|| packet[27]) {
                    Some(flags) if flags & 4 != 0 => &other_address,
                    Some(_) => &other_port,
                    None => &main,
                };
                from.send_to(&answer, source).unwrap();
            }
        });
        address
    }

    #[test]
    fn filtering_is_read_from_answers_that_come_from_elsewhere() {
        let mut survey = Survey { answered: 0, bracket_attempts: 0, addresses: Vec::new(), started: Instant::now(), samples: Vec::new(), unanswered: 0, local_ports: Vec::new(), brackets: Vec::new(), filtering: Vec::new() };
        // Nothing filters on the loopback: both answers come in.
        let able = observer_with_another_address(true);
        assert_eq!(survey.filtering(able), Some((true, true)));
        assert_eq!(survey.filtering, [(able, true, true)]);
        // An observer that names no other address is not asked.
        assert_eq!(survey.filtering(observer(Ipv4Addr::LOCALHOST, 1)), None);
        assert_eq!(survey.filtering.len(), 1);
        let ignores_change = observer_with_another_address(false);
        assert_eq!(survey.filtering(ignores_change), Some((false, false)));
    }
}
