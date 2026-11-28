//! The order in which one side sends to the ports of the other's address when it cannot be told
//! which port a mapping took.
//!
//! The side that cannot say opens a pool of sockets and sends from each to the one endpoint of
//! the side that can. The side that can then sends to ports of the pool's address until a packet
//! reaches a pool mapping. Which ports it sends to, and in which order, is this module.
//!
//! The product owns the order (`stratified_targets` in `channel-native/src/peer/preparation.rs`).
//! This copy serves the simulator and follows it.
use crate::mapping::LOWEST_PORT;

/// `parts` ports, one drawn from `draw` inside each of `parts` equal parts of the range from
/// [`LOWEST_PORT`] up. The parts are taken in the order of their number with its bits reversed,
/// turned by `start`, so every beginning of the order combs the whole range evenly. `parts` is a
/// power of two above one.
///
/// Where a NAT gives neighbouring ports to the mappings made toward one destination, a pool of
/// `n` sockets is a run of about `n` ports, and the comb reaches it within about 65,536 / `n`
/// packets whatever port the run began at. The draw inside each part keeps the ports off any
/// fixed remainder. The count with its bits reversed, which this replaced, has its first 1,024
/// ports 64 apart: a pool on every second port was missed by half of its starts, and one on
/// every 64th by nearly all.
pub fn order(parts: u32, start: u32, mut draw: impl FnMut() -> u64) -> impl Iterator<Item = u16> {
    assert!(parts.is_power_of_two() && parts > 1, "{parts} parts");
    let span = u64::from(u16::MAX - LOWEST_PORT) + 1;
    let shift = u32::BITS - parts.trailing_zeros();
    (0..parts).map(move |index| {
        let part = u64::from((index.reverse_bits() >> shift).wrapping_add(start) % parts);
        let lower = span * part / u64::from(parts);
        let width = span * (part + 1) / u64::from(parts) - lower;
        // A 64-bit draw leaves the remainder's bias far below what a simulation can see.
        LOWEST_PORT + (lower + draw() % width) as u16
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::{Nat, Ports, Scope};
    use std::collections::HashSet;
    use std::net::{Ipv4Addr, SocketAddrV4};

    /// What the product sends: 1,024 packets.
    const PACKETS: u32 = 1024;
    const POOL: u32 = 256;
    const SPAN: usize = (u16::MAX - LOWEST_PORT) as usize + 1;

    /// The order for one seed: a start and a sequence of draws that depend on nothing else.
    fn seeded(seed: u64) -> impl Iterator<Item = u16> {
        let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let mut draw = move || {
            // xorshift64: enough for a draw inside a part.
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let start = draw() as u32;
        order(PACKETS, start, draw)
    }

    #[test]
    fn every_part_gets_one_port() {
        let ports: Vec<u16> = seeded(7).collect();
        assert_eq!(ports.len(), PACKETS as usize);
        let parts: HashSet<usize> = ports.iter().map(|port| usize::from(port - LOWEST_PORT) * PACKETS as usize / SPAN).collect();
        assert_eq!(parts.len(), PACKETS as usize);
    }

    #[test]
    fn half_of_the_packets_reach_every_run_as_long_as_the_pool() {
        for seed in 0..50 {
            let mut sent = vec![false; 65_536];
            for port in seeded(seed).take(PACKETS as usize / 2) {
                sent[usize::from(port)] = true;
            }
            let run = POOL as usize;
            let reached = (usize::from(LOWEST_PORT)..=65_536 - run).all(|first| sent[first..first + run].iter().any(|sent| *sent));
            assert!(reached, "seed {seed}");
        }
    }

    #[test]
    fn a_pool_at_a_fixed_distance_is_not_missed_by_its_remainder() {
        // The count with its bits reversed reached 50, 25, 13 and 4 in 100 of these pools.
        for stride in [2usize, 4, 8, 64] {
            let reached = (0..400u64)
                .filter(|seed| {
                    let first = (seed.wrapping_mul(0xD1B5_4A32_D192_ED03) >> 40) as usize % SPAN;
                    let pool: HashSet<u16> = (0..POOL as usize).map(|index| LOWEST_PORT + ((first + stride * index) % SPAN) as u16).collect();
                    seeded(*seed).any(|port| pool.contains(&port))
                })
                .count();
            assert!(reached >= 380, "stride {stride}: {reached} of 400");
        }
    }

    const PEER: SocketAddrV4 = SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 9), 40_123);

    /// How many packets the side with one endpoint sends before one reaches a pool mapping, where
    /// the pool's NAT lets a packet in only from the endpoint its socket sent to.
    fn packets_until_reached(seed: u64, ports: Ports, foreign_per_second: f64) -> Option<usize> {
        let mut nat = Nat::new(seed, Ipv4Addr::new(198, 51, 100, 7), Scope::AddressAndPort, Scope::AddressAndPort, ports, foreign_per_second);
        // The pool is made at one socket every two milliseconds, as the product makes it.
        for socket in 0..POOL {
            nat.send(socket, PEER, socket * 2);
        }
        seeded(seed).position(|port| nat.receive(port, PEER).is_some()).map(|index| index + 1)
    }

    #[test]
    fn a_pool_on_one_destinations_counter_is_reached_by_half_of_the_packets() {
        // What a campus network showed: a counter for each destination, counting up by one, with
        // nobody else sending to that destination.
        for seed in 0..200 {
            let packets = packets_until_reached(seed, Ports::Destinations { counters: 4096 }, 0.0);
            assert!(packets.is_some_and(|packets| packets <= PACKETS as usize / 2), "seed {seed}: {packets:?}");
        }
        // Other subscribers taking fifty ports a second from the same counter stretch the run,
        // and a longer run is no harder to reach.
        for seed in 0..200 {
            assert!(packets_until_reached(seed, Ports::Destinations { counters: 4096 }, 50.0).is_some(), "seed {seed}");
        }
    }

    #[test]
    fn a_pool_drawn_at_random_is_reached_as_often_as_by_distinct_random_ports() {
        // 256 mappings and 1,024 ports among 64,512: about 98 in 100 whatever the ports.
        let reached = (0..400).filter(|seed| packets_until_reached(*seed, Ports::Drawn, 0.0).is_some()).count();
        assert!(reached >= 380, "{reached} of 400");
    }
}
