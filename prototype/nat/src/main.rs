//! Measures the NAT in front of this machine and prints what the model reads from it.
//!
//! It asks a few public STUN servers which address they see, from two sockets and then from more
//! when the answers differ, and prints a report to copy. It sends nothing else anywhere, and the
//! report shows only half of the public address unless `--full` is given.
//!
//! Where new mappings follow cursors it also tries the two things a pair of such networks needs,
//! with an observer standing in for the peer, because the observer says where the mapping really
//! landed: finding a mapping after it was made, and taking the ports next past a reading.
use piik_nat::mapping::{located, measured, replay, walk, Allocator, Budget, Cursor, Holdout, Model, PortSet, Sample};
use piik_nat::stun;
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, ToSocketAddrs, UdpSocket};
use std::time::{Duration, Instant};

/// Observers reachable from most networks, the product's defaults first. One appears on two ports
/// to show whether a mapping depends on the destination's port as well as its address.
const OBSERVERS: [&str; 9] = [
    "stun.cloudflare.com:3478",
    "stun.miwifi.com:3478",
    "stun.chat.bilibili.com:3478",
    "stun.l.google.com:19302",
    "stun.cloudflare.com:53",
    "stun.l.google.com:3478",
    "stun.qq.com:3478",
    "stun.hitv.com:3478",
    "stun.douyucdn.cn:18000",
];
/// One answer is waited for this long, twice.
const ANSWER: Duration = Duration::from_millis(700);
/// Mappings made from fresh sockets when the first answers differ, to see the allocator at work.
const EXTRA_MAPPINGS: usize = 10;
/// Measurements of one mapping between two observations.
const BRACKETS: usize = 5;
/// A replay judges a mapping once this many were made before it, against the aim a peer with the
/// product's present allowance would be given.
const REPLAY_AFTER: usize = 8;
const REPLAY_BUDGET: Budget = Budget { mappings: 256, packets: 1024 };
/// Mappings looked for after they were made, and the readings on each side of one.
const LOCATED: usize = 6;
const READINGS: usize = 5;
/// Times the most used cursor is read and then met with sockets one after another, the wait that
/// stands for the peer's answer before the second reading, and the sockets of one such time.
const CLIMBS: usize = 4;
const PEER_WAIT: Duration = Duration::from_millis(400);
const CLIMB_SOCKETS: usize = 8;

struct Survey {
    started: Instant,
    samples: Vec<Sample>,
    /// For each sample, the group it was sent in. The requests of one group were all sent before
    /// any of their answers was read, so none of them knew another's answer.
    groups: Vec<u32>,
    /// Requests that left and got no answer; their mappings were made all the same.
    unanswered: u32,
    /// Requests that could not be sent: no socket, or the send failed. No mapping was made.
    unsent: u32,
    /// The local port of each socket, by its number.
    local_ports: Vec<u16>,
}
impl Survey {
    /// Asks `observer` from `socket` and records the answer under `number`.
    fn ask(&mut self, socket: &UdpSocket, number: u16, observer: SocketAddrV4) -> Option<SocketAddrV4> {
        let sent_ms = self.started.elapsed().as_millis() as u32;
        let Some(transaction) = send(socket, observer) else {
            self.unsent += 1;
            return None;
        };
        let mapped = receive(socket, observer, transaction).or_else(|| {
            socket.send_to(&stun::request(transaction), observer).ok()?;
            receive(socket, observer, transaction)
        });
        let Some(mapped) = mapped else {
            self.unanswered += 1;
            return None;
        };
        self.record(&[Sample { socket: number, local_port: self.local_ports[usize::from(number)], observer, sent_ms, mapped }]);
        Some(mapped)
    }
    /// Records the answers of one group of requests.
    fn record(&mut self, answers: &[Sample]) {
        let group = self.groups.last().map_or(0, |last| last + 1);
        self.groups.extend(answers.iter().map(|_| group));
        self.samples.extend(answers);
    }
    fn socket(&mut self) -> Option<(UdpSocket, u16)> {
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
        socket.set_read_timeout(Some(ANSWER)).ok()?;
        self.local_ports.push(socket.local_addr().ok()?.port());
        Some((socket, (self.local_ports.len() - 1) as u16))
    }
    /// Makes one mapping toward each observer from a socket of its own, all sent before any answer
    /// is read, and records them in the order sent. The NAT meets them in that order unless the
    /// path reorders them.
    fn burst(&mut self, observers: &[SocketAddrV4]) -> Vec<Option<Sample>> {
        let sent: Vec<_> = observers
            .iter()
            .map(|observer| {
                let (socket, number) = self.socket()?;
                let sent_ms = self.started.elapsed().as_millis() as u32;
                Some((send(&socket, *observer)?, socket, number, sent_ms))
            })
            .collect();
        let left: Vec<bool> = sent.iter().map(Option::is_some).collect();
        let answers: Vec<Option<Sample>> = sent
            .into_iter()
            .zip(observers)
            .map(|(sent, &observer)| {
                let (transaction, socket, number, sent_ms) = sent?;
                // The mapping exists once the request has left, so asking again reads the same one.
                let mapped = receive(&socket, observer, transaction).or_else(|| {
                    socket.send_to(&stun::request(transaction), observer).ok()?;
                    receive(&socket, observer, transaction)
                })?;
                Some(Sample { socket: number, local_port: self.local_ports[usize::from(number)], observer, sent_ms, mapped })
            })
            .collect();
        self.unsent += left.iter().filter(|left| !**left).count() as u32;
        self.unanswered += answers.iter().zip(&left).filter(|(answer, left)| **left && answer.is_none()).count() as u32;
        self.record(&answers.iter().flatten().copied().collect::<Vec<_>>());
        answers
    }
    /// The new mappings seen on `address` so far, in the order they were made.
    fn allocations(&self, address: &Ipv4Addr) -> Vec<(u32, u16)> {
        allocations_on(&self.samples, address)
    }
}

/// A mapping made between readings and looked for afterwards.
struct Located {
    port: u16,
    /// Where [`located`] named the port, counting from one.
    rank: Option<usize>,
    named: usize,
}


/// Makes a mapping toward one observer between readings from the others, and asks the model where
/// it landed. The observer's answer is the truth the model does not see.
fn locate(survey: &mut Survey, observers: &[SocketAddrV4], public: &Ipv4Addr) -> Vec<Located> {
    let mut found = Vec::new();
    for round in 0..LOCATED {
        let peer = observers[round % observers.len()];
        let others: Vec<SocketAddrV4> = observers.iter().copied().filter(|observer| *observer != peer).collect();
        let readings = || -> Vec<SocketAddrV4> { (0..READINGS).map(|_| others[(random() % others.len() as u64) as usize]).collect() };
        // Each burst is answered before the next is sent, which keeps the three apart at the NAT.
        survey.burst(&readings());
        let before = survey.allocations(public);
        let Some(made) = survey.burst(&[peer])[0].filter(|made| made.mapped.ip() == public) else { continue };
        let after: Vec<u16> = survey.burst(&readings()).iter().flatten().filter(|sample| sample.mapped.ip() == public).map(|sample| sample.mapped.port()).collect();
        let named = located(&before, made.sent_ms, &after);
        found.push(Located { port: made.mapped.port(), rank: named.iter().position(|port| *port == made.mapped.port()).map(|at| at + 1), named: named.len() });
    }
    found
}

/// Reads the allocator, waits as long as a peer's answer takes, reads it again, and then opens
/// sockets toward one observer, each answered before the next. For each socket: how many steps past
/// the second reading of the most used cursor it landed, or nothing when it landed elsewhere. A peer
/// that had aimed one mapping at each of those steps would be met by a socket that sends to the
/// mapping of the step it takes.
fn climbs(survey: &mut Survey, observers: &[SocketAddrV4], public: &Ipv4Addr) -> Vec<Vec<Option<u16>>> {
    let mut climbed = Vec::new();
    for round in 0..CLIMBS {
        let peer = observers[round % observers.len()];
        let others: Vec<SocketAddrV4> = observers.iter().copied().filter(|observer| *observer != peer).collect();
        let readings = || -> Vec<SocketAddrV4> { (0..READINGS).map(|_| others[(random() % others.len() as u64) as usize]).collect() };
        survey.burst(&readings());
        std::thread::sleep(PEER_WAIT);
        survey.burst(&readings());
        let Allocator::Cursors(cursors) = Allocator::of(&survey.allocations(public)) else { break };
        let cursor = cursors[0];
        climbed.push(
            (0..CLIMB_SOCKETS)
                .map(|_| {
                    let made = survey.burst(&[peer])[0].filter(|made| made.mapped.ip() == public)?;
                    walk(cursor.last, cursor.step, made.mapped.port()).filter(|steps| usize::from(*steps) <= 4 * CLIMB_SOCKETS)
                })
                .collect(),
        );
    }
    climbed
}

fn send(socket: &UdpSocket, observer: SocketAddrV4) -> Option<[u8; 12]> {
    let mut transaction = [0; 12];
    for chunk in transaction.chunks_mut(8) {
        chunk.copy_from_slice(&random().to_ne_bytes()[..chunk.len()]);
    }
    socket.send_to(&stun::request(transaction), observer).ok()?;
    Some(transaction)
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

/// The samples that each show a new mapping on one public address, in the order they were made.
fn made_on<'a>(samples: &'a [Sample], address: &Ipv4Addr) -> Vec<&'a Sample> {
    let mut made: Vec<&Sample> = Vec::new();
    for sample in samples.iter().filter(|sample| sample.mapped.ip() == address) {
        // A socket that shows a port again is reading the mapping it already has.
        if !made.iter().any(|earlier| earlier.socket == sample.socket && earlier.mapped == sample.mapped) {
            made.push(sample);
        }
    }
    made
}

/// The new mappings a survey saw on one public address, in the order they were made.
fn allocations_on(samples: &[Sample], address: &Ipv4Addr) -> Vec<(u32, u16)> {
    made_on(samples, address).iter().map(|sample| (sample.sent_ms, sample.mapped.port())).collect()
}

/// The new mappings on one public address, each with the group it was sent in.
fn grouped(survey: &Survey, address: &Ipv4Addr) -> Vec<(u32, Sample)> {
    let made = made_on(&survey.samples, address);
    survey.samples.iter().zip(&survey.groups).filter(|(sample, _)| made.iter().any(|made| std::ptr::eq(*made, *sample))).map(|(sample, group)| (*group, *sample)).collect()
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
    let mut survey = Survey { started: Instant::now(), samples: Vec::new(), groups: Vec::new(), unanswered: 0, unsent: 0, local_ports: Vec::new() };
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
    for index in shuffled(observers.len()) {
        survey.ask(&second, second_number, observers[index].1);
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
    let (mut found, mut climbed) = (Vec::new(), Vec::new());
    if dependent {
        for _ in 0..EXTRA_MAPPINGS {
            if let Some((socket, number)) = survey.socket() {
                survey.ask(&socket, number, observers[(random() % observers.len() as u64) as usize].1);
            }
        }
        let public = *survey.samples[0].mapped.ip();
        if let Allocator::Cursors(cursors) = Allocator::of(&allocations_on(&survey.samples, &public)) {
            let step = cursors[0].step;
            // A mapping made between two observations, all three sent without waiting. These and
            // the burst after them are recorded and counted like every other request.
            for _ in 0..BRACKETS {
                let targets: Vec<SocketAddrV4> = (0..3).map(|index| observers[index % observers.len()].1).collect();
                let ports: Vec<Option<u16>> = survey.burst(&targets).iter().map(|answer| answer.map(|sample| sample.mapped.port())).collect();
                if let [Some(before), Some(between), Some(after)] = ports[..] {
                    brackets.push((before, between, after, measured(before, after, step) == Some(between)));
                }
            }
            // Eight mappings in one burst: how often other traffic falls between them.
            burst = survey.burst(&[observers[0].1; 8]).iter().flatten().map(|sample| sample.mapped.port()).collect();
            // The two experiments use the observers that a new socket reaches from this address,
            // so that a mapping made toward any of them lands on the allocator being read. Where
            // some traffic leaves through a proxy, a socket's first destination chooses its way out.
            let first_of = |socket: u16| survey.samples.iter().find(|sample| sample.socket == socket);
            let seeing: Vec<SocketAddrV4> = observers
                .iter()
                .map(|(_, observer)| *observer)
                .filter(|observer| {
                    let mut firsts = survey.samples.iter().filter(|sample| sample.observer == *observer && first_of(sample.socket).is_some_and(|first| first.observer == *observer && first.sent_ms == sample.sent_ms));
                    firsts.clone().count() > 0 && firsts.all(|sample| *sample.mapped.ip() == public)
                })
                .collect();
            if seeing.len() >= 2 {
                found = locate(&mut survey, &seeing, &public);
                climbed = climbs(&mut survey, &seeing, &public);
            }
        }
    }
    report(&survey, &observers, by_port, &brackets, &burst, &found, &climbed, full);
}

/// The cursors of an allocator in one line: each with its last port, its step and how many mappings landed on it.
fn cursors_line(cursors: &[Cursor]) -> String {
    let each: Vec<String> = cursors
        .iter()
        .map(|cursor| format!("{} step {} x{} ({:.1}/s)", cursor.last, cursor.step, cursor.landings, cursor.per_second()))
        .collect();
    format!("CURSORS. {} counter(s), next mapping one step past one of: {}", cursors.len(), each.join(", "))
}

#[allow(clippy::too_many_arguments)]
fn report(
    survey: &Survey,
    observers: &[(&str, SocketAddrV4)],
    by_port: Option<bool>,
    brackets: &[(u16, u16, u16, bool)],
    burst: &[u16],
    found: &[Located],
    climbed: &[Vec<Option<u16>>],
    full: bool,
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
        Ok(model) => match model.allocator.clone() {
            Allocator::Point { port, preserved } => {
                println!("model: POINT. One mapping per socket whatever the destination (port {port}); local port kept: {}", if preserved { "yes" } else { "no" });
            }
            Allocator::Cursors(ref cursors) => println!("model: {}", cursors_line(cursors)),
            Allocator::Set(set @ PortSet::Span { low, high, seen }) => {
                println!("model: SET. {seen} ports seen between {low} and {high} ({} ports); the next lies inside with {:.0}%", set.size(), set.holds() * 100.0)
            }
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
    // The survey judged by itself: each mapping against the aim read from what was known before
    // it, reading everything, only other destinations, and only other addresses.
    let made = grouped(survey, &public);
    println!(
        "requests: {} answered ({} new mappings on this address), {} left and got no answer, {} could not be sent",
        survey.samples.len(),
        made.len(),
        survey.unanswered,
        survey.unsent
    );
    for (reading, holdout) in [("all earlier mappings", Holdout::Nothing), ("other destinations", Holdout::Destination), ("other addresses", Holdout::Address)] {
        let replayed = replay(&made, REPLAY_AFTER, holdout, REPLAY_BUDGET);
        println!(
            "replay reading {reading}: held {}, missed {}, no aim {}, too little before {}, made in a burst and not judged {}",
            replayed.held, replayed.missed, replayed.no_aim, replayed.too_early, replayed.in_bursts
        );
    }
    if !found.is_empty() {
        let first = found.iter().filter(|located| located.rank == Some(1)).count();
        let named = found.iter().filter(|located| located.rank.is_some()).count();
        let each: Vec<String> = found.iter().map(|located| format!("{}:{}/{}", located.port, located.rank.map_or("-".into(), |rank| rank.to_string()), located.named)).collect();
        println!("found afterwards: {first} of {} named first, {named} named at all (port:rank/named) {}", found.len(), each.join(" "));
    }
    if !climbed.is_empty() {
        let next = climbed.iter().filter(|steps| steps.iter().flatten().next() == Some(&1)).count();
        let each: Vec<String> = climbed.iter().map(|steps| steps.iter().map(|step| step.map_or("-".into(), |step| step.to_string())).collect::<Vec<_>>().join(" ")).collect();
        println!("steps past a reading, socket by socket: the cursor's next port was taken in {next} of {} | {}", climbed.len(), each.join(" | "));
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
            let allocations = allocations_on(&survey.samples, address);
            let read = match Allocator::of(&allocations) {
                Allocator::Cursors(cursors) => cursors_line(&cursors),
                other => format!("{other:?}"),
            };
            println!("  {} {}: {} mappings, {read}", letter(address), shown(*address), allocations.len());
        }
    }
    if addresses.len() > 1 {
        println!("note: more than one public address was seen, so a proxy or VPN carries part of this machine's traffic. Turn it off and run again to read the network itself.");
    }
    // The cursors that the mappings toward each observer used: a peer is one more destination.
    for (index, (_, observer)) in observers.iter().enumerate() {
        let toward: Vec<(u32, u16)> = made_on(&survey.samples, &public).iter().filter(|sample| sample.observer == *observer).map(|sample| (sample.sent_ms, sample.mapped.port())).collect();
        if let Allocator::Cursors(cursors) = Allocator::of(&toward) {
            let each: Vec<String> = cursors.iter().take(6).map(|cursor| format!("{}x{}", cursor.last, cursor.landings)).collect();
            println!("toward observer {index}: {} mappings on {} cursor(s): {}", toward.len(), cursors.len(), each.join(" "));
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
