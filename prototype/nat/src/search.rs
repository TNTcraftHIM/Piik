//! The order in which one side sends to the ports of the other's address when it cannot be told
//! which port a mapping took.
//!
//! The side that cannot say opens a pool of sockets and sends from each to the one endpoint of
//! the side that can. The side that can then sends to ports of the pool's address until a packet
//! reaches a pool mapping. Which ports it sends to, and in which order, is this module.
use crate::mapping::LOWEST_PORT;

/// Every port from [`LOWEST_PORT`] up, once, in an order whose every beginning combs the whole
/// range evenly: among the first 2^k ports, each run of 65,536 / 2^k neighbouring ports holds
/// one. The first port is `start`, so a guess goes first where there is one, and a draw makes the
/// order differ from one attempt to the next.
///
/// Where a NAT gives neighbouring ports to the mappings made toward one destination, a pool of
/// `n` sockets is a run of about `n` ports, and the order reaches it within 65,536 / `n` packets
/// whatever port the run began at. Where the pool's ports are drawn at random, any distinct ports
/// do equally well, so the order costs nothing there. It is the 16-bit count with its bits
/// reversed.
pub fn order(start: u16) -> impl Iterator<Item = u16> {
    (0..=u16::MAX).map(move |index| index.reverse_bits().wrapping_add(start)).filter(|port| *port >= LOWEST_PORT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::{Nat, Ports, Scope};
    use std::net::{Ipv4Addr, SocketAddrV4};

    #[test]
    fn the_order_starts_at_the_guess_and_names_every_port_once() {
        let ports: Vec<u16> = order(40_000).collect();
        assert_eq!(ports[0], 40_000);
        assert_eq!(ports.len(), usize::from(u16::MAX - LOWEST_PORT) + 1);
        let mut sorted = ports.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), ports.len());
        assert!(ports.iter().all(|port| *port >= LOWEST_PORT));
    }

    #[test]
    fn every_beginning_reaches_every_run_of_its_length() {
        for start in [LOWEST_PORT, 40_000, 65_535, 7] {
            for power in [4u32, 6, 8, 10] {
                let mut sent = vec![false; 65_536];
                for port in order(start).take(1 << power) {
                    sent[usize::from(port)] = true;
                }
                let run = 65_536usize >> power;
                let reached = (usize::from(LOWEST_PORT)..=65_536 - run).all(|first| sent[first..first + run].iter().any(|sent| *sent));
                assert!(reached, "start {start}, 2^{power} packets, runs of {run}");
            }
        }
    }

    const PEER: SocketAddrV4 = SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 9), 40_123);
    const POOL: u32 = 256;

    /// How many packets the side with one endpoint sends before one reaches a pool mapping, where
    /// the pool's NAT lets a packet in only from the endpoint its socket sent to.
    fn packets_until_reached(seed: u64, ports: Ports, foreign_per_second: f64, budget: usize) -> Option<usize> {
        let mut nat = Nat::new(seed, Ipv4Addr::new(198, 51, 100, 7), Scope::AddressAndPort, Scope::AddressAndPort, ports, foreign_per_second);
        // The pool is made at one socket every two milliseconds, as the product makes it.
        for socket in 0..POOL {
            nat.send(socket, PEER, socket * 2);
        }
        let start = (seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 48) as u16;
        order(start).take(budget).position(|port| nat.receive(port, PEER).is_some()).map(|index| index + 1)
    }

    #[test]
    fn a_pool_on_one_destinations_counter_is_reached_within_the_range_over_its_size() {
        // What a campus network showed: a counter for each destination, counting up by one, with
        // nobody else sending to that destination.
        for seed in 0..200 {
            let packets = packets_until_reached(seed, Ports::Destinations { counters: 4096 }, 0.0, 1024);
            assert!(packets.is_some_and(|packets| packets <= 256), "seed {seed}: {packets:?}");
        }
        // Other subscribers taking fifty ports a second from the same counter stretch the run;
        // the order goes on combing more finely and still arrives.
        for seed in 0..200 {
            assert!(packets_until_reached(seed, Ports::Destinations { counters: 4096 }, 50.0, 1024).is_some(), "seed {seed}");
        }
    }

    #[test]
    fn a_pool_drawn_at_random_is_reached_as_often_as_by_distinct_random_ports() {
        // 256 mappings and 1,024 distinct ports among 64,512: about 98 in 100 whatever the ports.
        let reached = (0..400).filter(|seed| packets_until_reached(*seed, Ports::Drawn, 0.0, 1024).is_some()).count();
        assert!(reached >= 380, "{reached} of 400");
    }
}
