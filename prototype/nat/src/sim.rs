//! A NAT in memory, for trying plans without a network.
//!
//! It gives public ports to outgoing packets the way a chosen kind of NAT does, lets other
//! subscribers take ports meanwhile, and decides what may come back in. Nothing here opens a
//! socket or sends a packet: a test asks it where a packet would leave from, and whether one
//! arriving would get through.
use crate::mapping::LOWEST_PORT;
use std::net::{Ipv4Addr, SocketAddrV4};

/// How much of a destination a mapping or a filter is tied to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    /// Nothing: one mapping per socket, or packets let in from anywhere.
    Any,
    /// The destination's address.
    Address,
    /// Its address and port.
    AddressAndPort,
}

/// How a new mapping gets its port.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ports {
    /// The socket's own port.
    Kept,
    /// One counter for every mapping.
    Counter { step: u16 },
    /// Several counters. Each walks a block of `block` ports and moves on `stride` blocks at the
    /// block's end. A destination uses a few of them, the first half the time, the second a
    /// quarter and so on, and which one a mapping takes does not follow its socket from one
    /// destination to another.
    Lanes { counters: u16, block: u16, stride: u16 },
    /// A draw from all ports.
    Drawn,
}

struct Mapped {
    socket: u32,
    to: SocketAddrV4,
    port: u16,
    sent: Vec<SocketAddrV4>,
}

pub struct Nat {
    pub address: Ipv4Addr,
    mapping: Scope,
    filtering: Scope,
    ports: Ports,
    /// Mappings that other subscribers make on each counter in a second.
    foreign_per_second: f64,
    secret: u64,
    random: u64,
    /// The port each counter gives next.
    counters: Vec<u16>,
    now_ms: u32,
    mappings: Vec<Mapped>,
}

const SPAN: u32 = u16::MAX as u32 - LOWEST_PORT as u32 + 1;
/// The local port of socket `socket`, which a NAT that keeps ports shows.
pub fn local_port(socket: u32) -> u16 {
    50_000 + (socket % 10_000) as u16
}

fn mix(value: u64) -> u64 {
    let value = (value ^ (value >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    let value = (value ^ (value >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    value ^ (value >> 31)
}

impl Nat {
    pub fn new(seed: u64, address: Ipv4Addr, mapping: Scope, filtering: Scope, ports: Ports, foreign_per_second: f64) -> Self {
        let mut nat = Self {
            address,
            mapping,
            filtering,
            ports,
            foreign_per_second,
            secret: mix(seed),
            random: mix(seed.wrapping_add(1)) | 1,
            counters: Vec::new(),
            now_ms: 0,
            mappings: Vec::new(),
        };
        let counters = match ports {
            Ports::Lanes { counters, .. } => counters,
            _ => 1,
        };
        nat.counters = (0..counters).map(|_| LOWEST_PORT + (nat.draw() % u64::from(SPAN)) as u16).collect();
        nat
    }

    fn draw(&mut self) -> u64 {
        self.random ^= self.random >> 12;
        self.random ^= self.random << 25;
        self.random ^= self.random >> 27;
        self.random.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// The port a counter gives after `port`.
    fn after(&self, port: u16) -> u16 {
        let next = match self.ports {
            Ports::Counter { step } => u32::from(port) + u32::from(step),
            Ports::Lanes { block, stride, .. } => {
                let offset = (u32::from(port) - u32::from(LOWEST_PORT)) % u32::from(block);
                match offset + 1 < u32::from(block) {
                    true => u32::from(port) + 1,
                    false => u32::from(port) + 1 + u32::from(stride - 1) * u32::from(block),
                }
            }
            Ports::Kept | Ports::Drawn => u32::from(port) + 1,
        };
        (u32::from(LOWEST_PORT) + (next - u32::from(LOWEST_PORT)) % SPAN) as u16
    }

    fn take(&mut self, counter: usize) -> u16 {
        let port = self.counters[counter];
        self.counters[counter] = self.after(port);
        port
    }

    /// Lets time pass: other subscribers take ports from every counter.
    fn pass(&mut self, now_ms: u32) {
        let mean = self.foreign_per_second * f64::from(now_ms.saturating_sub(self.now_ms)) / 1000.0;
        self.now_ms = self.now_ms.max(now_ms);
        if mean <= 0.0 {
            return;
        }
        for counter in 0..self.counters.len() {
            // A Poisson count by multiplying uniform draws down to its floor.
            let (floor, mut product) = ((-mean).exp(), 1.0);
            loop {
                product *= (self.draw() >> 11) as f64 / (1u64 << 53) as f64;
                if product <= floor {
                    break;
                }
                self.take(counter);
            }
        }
    }

    /// The counter a new mapping from `socket` to `to` takes.
    fn lane(&self, socket: u32, to: SocketAddrV4, counters: u16) -> usize {
        let destination = mix(self.secret ^ (u64::from(u32::from(*to.ip())) << 16) ^ u64::from(to.port()));
        let rank = mix(destination ^ u64::from(socket).wrapping_mul(0x9E37_79B9_7F4A_7C15)).trailing_ones().min(5);
        (mix(destination.wrapping_add(u64::from(rank))) % u64::from(counters)) as usize
    }

    /// A packet leaves `socket` for `to` at `now_ms`. Returns the public port it leaves from.
    pub fn send(&mut self, socket: u32, to: SocketAddrV4, now_ms: u32) -> u16 {
        self.pass(now_ms);
        let mapping = self.mapping;
        let shares = |mapped: &Mapped| {
            mapped.socket == socket
                && match mapping {
                    Scope::Any => true,
                    Scope::Address => mapped.to.ip() == to.ip(),
                    Scope::AddressAndPort => mapped.to == to,
                }
        };
        if let Some(mapped) = self.mappings.iter_mut().find(|mapped| shares(mapped)) {
            if !mapped.sent.contains(&to) {
                mapped.sent.push(to);
            }
            return mapped.port;
        }
        let port = match self.ports {
            Ports::Kept => local_port(socket),
            Ports::Counter { .. } => self.take(0),
            Ports::Lanes { counters, .. } => self.take(self.lane(socket, to, counters)),
            Ports::Drawn => LOWEST_PORT + (self.draw() % u64::from(SPAN)) as u16,
        };
        self.mappings.push(Mapped { socket, to, port, sent: vec![to] });
        port
    }

    /// A packet arrives at public port `port` from `from`. Returns the socket it reaches, when the
    /// NAT lets it in.
    pub fn receive(&self, port: u16, from: SocketAddrV4) -> Option<u32> {
        let filtering = self.filtering;
        self.mappings
            .iter()
            .find(|mapped| {
                mapped.port == port
                    && match filtering {
                        Scope::Any => true,
                        Scope::Address => mapped.sent.iter().any(|sent| sent.ip() == from.ip()),
                        Scope::AddressAndPort => mapped.sent.contains(&from),
                    }
            })
            .map(|mapped| mapped.socket)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mapping::{part, Aim, Allocator, Budget, Model, Part, PortSet, Sample};

    const BUDGET: Budget = Budget { mappings: 256, packets: 1024 };
    const LANES: Ports = Ports::Lanes { counters: 32, block: 31, stride: 8 };
    const HARD: Ipv4Addr = Ipv4Addr::new(203, 0, 113, 7);
    const EASY: Ipv4Addr = Ipv4Addr::new(192, 0, 2, 9);

    fn observer(index: u32) -> SocketAddrV4 {
        // Two ports on each of several addresses, as public servers offer.
        SocketAddrV4::new(Ipv4Addr::new(198, 51, 100, 1 + (index / 2) as u8), 3478 + (index % 2) as u16)
    }

    /// A survey as the tool makes it: two sockets ask every observer, then `extra` new sockets ask
    /// one observer each, a tenth of a second apart. Returns the samples and the time it ended.
    fn survey(nat: &mut Nat, observers: u32, extra: u32) -> (Vec<Sample>, u32) {
        let (mut samples, mut now_ms) = (Vec::new(), 0);
        let mut ask = |nat: &mut Nat, socket: u32, to: SocketAddrV4, now_ms: &mut u32| {
            *now_ms += 100;
            let mapped = SocketAddrV4::new(nat.address, nat.send(socket, to, *now_ms));
            samples.push(Sample { socket: socket as u16, local_port: local_port(socket), observer: to, sent_ms: *now_ms, mapped });
        };
        for socket in 0..2 {
            for index in 0..observers {
                ask(nat, socket, observer(index), &mut now_ms);
            }
        }
        for socket in 2..2 + extra {
            ask(nat, socket, observer(socket % observers), &mut now_ms);
        }
        (samples, now_ms)
    }

    #[test]
    fn the_model_reads_each_kind_of_nat() {
        let read = |mapping, ports| {
            let mut nat = Nat::new(7, HARD, mapping, Scope::AddressAndPort, ports, 0.2);
            Model::read(&survey(&mut nat, 6, 24).0).unwrap().allocator
        };
        assert_eq!(read(Scope::Any, Ports::Kept), Allocator::Point { port: local_port(0), preserved: true });
        assert!(matches!(read(Scope::Any, Ports::Drawn), Allocator::Point { preserved: false, .. }));
        assert!(matches!(read(Scope::AddressAndPort, Ports::Counter { step: 1 }), Allocator::Cursors(cursors) if cursors.len() == 1));
        assert!(matches!(read(Scope::AddressAndPort, LANES), Allocator::Cursors(cursors) if cursors.len() > 3));
        assert!(matches!(read(Scope::AddressAndPort, Ports::Drawn), Allocator::Set(PortSet::Span { .. })));
    }

    #[test]
    fn a_filter_lets_in_what_its_scope_allows() {
        let peer = SocketAddrV4::new(EASY, 40_000);
        let other_port = SocketAddrV4::new(EASY, 40_001);
        let stranger = SocketAddrV4::new(Ipv4Addr::new(198, 51, 100, 77), 40_000);
        let admits = |filtering| {
            let mut nat = Nat::new(1, HARD, Scope::AddressAndPort, filtering, Ports::Counter { step: 1 }, 0.0);
            let port = nat.send(3, peer, 10);
            [peer, other_port, stranger].map(|from| nat.receive(port, from) == Some(3))
        };
        assert_eq!(admits(Scope::Any), [true, true, true]);
        assert_eq!(admits(Scope::Address), [true, true, false]);
        assert_eq!(admits(Scope::AddressAndPort), [true, false, false]);
    }

    /// A NAT with one mapping per socket against one with lanes: the easy side sends to the ports
    /// the model aims at, and the hard side opens `sockets` toward it. Returns how many of `trials`
    /// pairs met, and the packets the easy side sent in each.
    fn point_meets_lanes(observers: u32, extra: u32, sockets: u32, trials: u64) -> (u64, usize) {
        let (mut met, mut packets) = (0, 0);
        for seed in 0..trials {
            let mut hard = Nat::new(seed, HARD, Scope::AddressAndPort, Scope::AddressAndPort, LANES, 0.5);
            let mut easy = Nat::new(seed + 9_000, EASY, Scope::Any, Scope::AddressAndPort, Ports::Kept, 0.0);
            let (samples, ended_ms) = survey(&mut hard, observers, extra);
            let model = Model::read(&samples).unwrap();
            let easy_port = easy.send(0, observer(0), 0);
            let easy_model = Model { address: EASY, allocator: Allocator::Point { port: easy_port, preserved: true } };
            let open_ms = ended_ms + 300;
            let Some(aim) = model.aim(open_ms) else { continue };
            let Some(Part::Sweep(windows)) = part(&easy_model, &Aim::Port(easy_port), &aim, HARD, BUDGET) else { continue };
            // The hard side opens toward the easy side's one mapping, and the easy side sweeps.
            let opened: Vec<u16> = (0..sockets).map(|socket| hard.send(1_000 + socket, SocketAddrV4::new(EASY, easy_port), open_ms)).collect();
            let mut reached = false;
            packets = 0;
            for window in &windows {
                for index in 0..window.count {
                    let port = (i32::from(window.first) + i32::from(window.step) * i32::from(index)) as u16;
                    easy.send(0, SocketAddrV4::new(HARD, port), open_ms + 50);
                    packets += 1;
                    // A packet that finds a mapping of the hard side gets in, and its answer comes back.
                    reached |= opened.contains(&port)
                        && hard.receive(port, SocketAddrV4::new(EASY, easy_port)).is_some()
                        && easy.receive(easy_port, SocketAddrV4::new(HARD, port)) == Some(0);
                }
            }
            met += u64::from(reached);
        }
        (met, packets)
    }

    #[test]
    fn more_destinations_read_and_more_sockets_opened_meet_more_often() {
        const TRIALS: u64 = 400;
        let few_one = point_meets_lanes(4, 10, 1, TRIALS);
        let few_eight = point_meets_lanes(4, 10, 8, TRIALS);
        let many_one = point_meets_lanes(12, 36, 1, TRIALS);
        let many_eight = point_meets_lanes(12, 36, 8, TRIALS);
        eprintln!("point x lanes, met of {TRIALS}: 4 destinations read: 1 socket {few_one:?}, 8 sockets {few_eight:?}; 12 read: 1 socket {many_one:?}, 8 sockets {many_eight:?}");
        assert!(few_eight.0 > few_one.0 && many_eight.0 > many_one.0);
        assert!(many_one.0 > few_one.0 && many_eight.0 > few_eight.0);
        assert!(many_eight.0 * 2 > TRIALS);
    }

    /// What one side has read of its own NAT: each mapping's time, port and destination.
    struct Side {
        nat: Nat,
        read: Vec<(u32, u16, SocketAddrV4)>,
        sockets: u32,
    }
    impl Side {
        fn new(nat: Nat) -> Self {
            Self { nat, read: Vec::new(), sockets: 0 }
        }
        /// A new socket sends to `to`; the port is returned as an observer would tell it.
        fn open(&mut self, to: SocketAddrV4, now_ms: u32) -> u16 {
            self.sockets += 1;
            self.nat.send(self.sockets, to, now_ms)
        }
        fn ask(&mut self, to: SocketAddrV4, now_ms: u32) -> u16 {
            let port = self.open(to, now_ms);
            self.read.push((now_ms, port, to));
            port
        }
        fn allocations(&self) -> Vec<(u32, u16)> {
            self.read.iter().map(|&(at_ms, port, _)| (at_ms, port)).collect()
        }
    }

    /// How a trial of two lane NATs ended.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum End {
        Met,
        NoCounter,
        PastTheNamed,
        NoHoleIsAMapping,
        AnotherHoleTookThePort,
        NothingLandedOnTheCounter,
    }

    /// Two NATs with lanes. B names the ports next past the counter its readings landed on most.
    /// For each of them A opens `sockets` toward it and names the holes they left between its
    /// readings. B reads its counter again and opens sockets toward A's holes for the port that
    /// is now next; the first of them to land on that counter holds the port named. Returns
    /// how it ended and the sockets each side used.
    fn lanes_meet_lanes(seed: u64, observers: u32, sockets: u32, rungs: u16, tries: u32) -> (End, u32, u32) {
        const LATENCY_MS: u32 = 200;
        const HOLES: usize = 64;
        let hard = |seed, address| Nat::new(seed, address, Scope::AddressAndPort, Scope::AddressAndPort, LANES, 0.5);
        let (mut a, mut b) = (Side::new(hard(seed, HARD)), Side::new(hard(seed + 50_000, EASY)));
        let mut now_ms = 0;
        // Both read their counters through every destination, three times each.
        for _ in 0..3 {
            for index in 0..observers {
                now_ms += 20;
                a.ask(observer(index), now_ms);
                b.ask(observer(index), now_ms);
            }
        }
        let used = |a: &Side, b: &Side| (a.sockets, b.sockets);
        let Allocator::Cursors(cursors) = Allocator::of(&b.allocations()) else { return (End::NoCounter, a.sockets, b.sockets) };
        let (frontier, step) = (cursors[0].last, i32::from(cursors[0].step));
        let on_counter = |port: u16, from: u16| (1..=40).contains(&((i32::from(port) - i32::from(from)) * step));
        // The destinations whose mappings landed on that counter read it again later.
        let readers: Vec<SocketAddrV4> = b.read.iter().filter(|&&(_, port, _)| port == frontier || on_counter(frontier, port)).map(|&(_, _, to)| to).collect();
        let named: Vec<u16> = (1..=rungs).map(|rung| (i32::from(frontier) + step * i32::from(rung)) as u16).collect();
        now_ms += LATENCY_MS;
        // A, for each port named: readings, the sockets toward it, readings, and the holes between.
        let mut holes: Vec<Vec<u16>> = Vec::new();
        for &port in &named {
            let before = a.allocations();
            now_ms += 20;
            let opened_ms = now_ms;
            for _ in 0..sockets {
                a.open(SocketAddrV4::new(EASY, port), opened_ms);
            }
            now_ms += 20;
            // Two readings toward every destination: a run is found when one of them lands past it.
            let after: Vec<u16> = (0..2 * observers).map(|index| a.ask(observer(index % observers), now_ms)).collect();
            holes.push(crate::mapping::holes(&before, opened_ms, &after).into_iter().take(HOLES).collect());
        }
        now_ms += LATENCY_MS;
        // B reads its counter again to learn which named port is next.
        let mut next = None;
        for index in 0..8 {
            now_ms += 5;
            let port = b.ask(readers[index % readers.len()], now_ms);
            if on_counter(port, frontier) {
                next = Some((i32::from(port) + step) as u16);
                break;
            }
        }
        let Some(rung) = next.and_then(|next| named.iter().position(|port| *port == next)) else { return (End::PastTheNamed, a.sockets, b.sockets) };
        let live = |a: &Side, hole: u16| a.nat.receive(hole, SocketAddrV4::new(EASY, named[rung])).is_some();
        if !holes[rung].iter().any(|hole| live(&a, *hole)) {
            return (End::NoHoleIsAMapping, a.sockets, b.sockets);
        }
        for _ in 0..tries {
            for &hole in &holes[rung] {
                now_ms += 1;
                if b.open(SocketAddrV4::new(HARD, hole), now_ms) == named[rung] {
                    // This socket holds the port named. It meets A when the hole is a mapping of A's.
                    let met = live(&a, hole) && b.nat.receive(named[rung], SocketAddrV4::new(HARD, hole)).is_some();
                    let (a_used, b_used) = used(&a, &b);
                    return (if met { End::Met } else { End::AnotherHoleTookThePort }, a_used, b_used);
                }
            }
        }
        (End::NothingLandedOnTheCounter, a.sockets, b.sockets)
    }

    #[test]
    fn two_lane_nats_meet_sometimes() {
        const TRIALS: u64 = 300;
        let rate = |observers, sockets, rungs, tries| {
            let (mut ends, mut a_used, mut b_used) = ([0u64; 6], 0u64, 0u64);
            for seed in 0..TRIALS {
                let (end, a, b) = lanes_meet_lanes(seed, observers, sockets, rungs, tries);
                ends[end as usize] += 1;
                a_used += u64::from(a);
                b_used += u64::from(b);
            }
            (ends, a_used / TRIALS, b_used / TRIALS)
        };
        let small = rate(12, 8, 3, 6);
        let large = rate(24, 24, 3, 8);
        let wide = rate(24, 24, 2, 8);
        eprintln!("lanes x lanes of {TRIALS}, ([met, no counter, past the named, no hole is a mapping, another hole took the port, nothing landed], A's sockets, B's sockets):
  12 destinations read, 8 sockets for each of 3 ports named: {small:?}
  24 destinations, 24 sockets, 3 ports: {large:?}
  24 destinations, 24 sockets, 2 ports: {wide:?}");
        assert!(small.0[End::Met as usize] > 0);
    }
}
