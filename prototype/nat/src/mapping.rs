//! What a survey tells about a NAT's port allocator, and where its next mappings will be.
//!
//! A survey is a table of samples: which socket asked which observer when, and the address the
//! observer saw. This module reads one of three allocators from it: a point (the mapping does not
//! depend on the destination), a counter that other traffic advances too, or draws from a set of
//! ports. [`Model::aim`] turns the allocator into ports a peer can use, [`part`] says what one side
//! does about the other's aim, and [`chance`] gives the probability that the two parts meet.
//!
//! One bound holds for every plan. A mapping bound to one destination port meets only a peer mapping
//! aimed at exactly it, so with `m` and `n` such mappings drawn from sets of `r` and `s` ports the
//! expected number of meetings is `m·n / (r·s)`. Two set allocators therefore have no part here.
//!
//! Every decision is integer arithmetic, so two endpoints reach the same plan. The probabilities
//! are floating point and decide nothing between endpoints.
use std::net::{Ipv4Addr, SocketAddrV4};

/// The lowest port a mapping is expected on; lower ports are not searched.
pub const LOWEST_PORT: u16 = 1024;
/// A counter's step is at most this, as in the three-sample rule this module replaces.
const MAX_STEP: u32 = 16;
/// A sequence that rises or falls by chance has enormous implied traffic; a real counter rarely sees
/// more foreign allocations than this in a second.
const MAX_FOREIGN_PER_SECOND: u64 = 2_000;
/// Samples that agree on an RFC 7597 port-set identifier must rule out chance to one in 2^16.
const PORT_SET_EVIDENCE_BITS: u32 = 16;
/// Offset and identifier lengths of RFC 7597 port sets in use, the most specific first.
const PORT_SET_SHAPES: [(u8, u8); 5] = [(4, 8), (6, 8), (4, 6), (6, 6), (6, 4)];
/// A window holds the Poisson mass within this many standard deviations of the mean, squared and
/// times a hundred: 3.3 deviations hold 99.9%.
const WINDOW_DEVIATIONS_SQUARED_X100: u64 = 1_089;
/// Two packets of one burst leave this many microseconds apart; a foreign allocation that falls
/// between them moves a mapping off the port it was meant for.
const BURST_SPACING_US: f64 = 200.0;
/// A pool and a search of `p` and `q` ports in a set of `s` meet with probability
/// `1 - exp(-p·q/s)`; `p·q = 4.6·s` gives 99%.
const POOL_PRODUCT_X10: u64 = 46;

/// One answer of a survey.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sample {
    pub socket: u8,
    pub observer: SocketAddrV4,
    /// Milliseconds since the survey began.
    pub sent_ms: u32,
    pub mapped: SocketAddrV4,
}

/// The ports a set allocator draws from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PortSet {
    Span { low: u16, high: u16 },
    /// An RFC 7597 port set: `offset` leading bits that are never all zero, then `length` bits equal
    /// to `psid`, then the rest free.
    Shared { offset: u8, length: u8, psid: u16 },
}
impl PortSet {
    pub fn size(&self) -> u32 {
        match *self {
            Self::Span { low, high } => u32::from(high) - u32::from(low) + 1,
            Self::Shared { offset, length, .. } => ((1 << offset) - 1) << (16 - offset - length),
        }
    }
    pub fn contains(&self, port: u16) -> bool {
        match *self {
            Self::Span { low, high } => (low..=high).contains(&port),
            Self::Shared { offset, length, psid } => {
                let free = 16 - offset - length;
                port >> (16 - offset) != 0 && (port >> free) & ((1 << length) - 1) == psid
            }
        }
    }
    /// The `index`-th port of the set in rising order; `index` is below [`Self::size`].
    pub fn nth(&self, index: u32) -> u16 {
        match *self {
            Self::Span { low, .. } => low + index as u16,
            Self::Shared { offset, length, psid } => {
                let free = 16 - offset - length;
                let lead = (index >> free) as u16 + 1;
                lead << (16 - offset) | psid << free | (index & ((1 << free) - 1)) as u16
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Allocator {
    /// One mapping whatever the destination.
    Point { port: u16 },
    /// Each new mapping takes the next `step` of one counter. `last` was seen at `at_ms`, and other
    /// traffic took `foreign_per_ks` allocations in a thousand seconds.
    Counter { last: u16, at_ms: u32, step: i16, foreign_per_ks: u32 },
    /// Each new mapping is a draw from a set.
    Set(PortSet),
}

impl Allocator {
    /// The allocator behind new mappings, each given as its time in milliseconds and its port, in
    /// the order they were made: a counter when they rise or fall in small steps, or else a set.
    pub fn of(allocations: &[(u32, u16)]) -> Self {
        counter(allocations).unwrap_or_else(|| Self::Set(port_set(allocations)))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Model {
    pub address: Ipv4Addr,
    pub allocator: Allocator,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unusable {
    /// No socket asked two observers, so nothing shows whether the mapping depends on them.
    TooFew,
    /// The observers saw different addresses.
    AddressesDiffer,
}

impl Model {
    /// Reads the allocator from a survey. Samples may come in any order.
    pub fn read(samples: &[Sample]) -> Result<Self, Unusable> {
        let first = samples.first().ok_or(Unusable::TooFew)?;
        let address = *first.mapped.ip();
        if samples.iter().any(|sample| *sample.mapped.ip() != address) {
            return Err(Unusable::AddressesDiffer);
        }
        let compared = samples.iter().any(|sample| {
            samples.iter().any(|other| other.socket == sample.socket && other.observer != sample.observer)
        });
        if !compared {
            return Err(Unusable::TooFew);
        }
        let mut ordered = samples.to_vec();
        ordered.sort_by_key(|sample| sample.sent_ms);
        // A socket that shows one port to every observer has one mapping. The model speaks for
        // the earliest socket; the caller keeps that socket.
        let independent = ordered.iter().all(|sample| {
            ordered
                .iter()
                .all(|other| other.socket != sample.socket || other.mapped == sample.mapped)
        });
        if independent {
            return Ok(Self { address, allocator: Allocator::Point { port: ordered[0].mapped.port() } });
        }
        // What remains is one new mapping for each port not seen before on its socket.
        let mut allocations: Vec<(u32, u16)> = Vec::with_capacity(ordered.len());
        for (index, sample) in ordered.iter().enumerate() {
            let repeated = ordered[..index]
                .iter()
                .any(|earlier| earlier.socket == sample.socket && earlier.mapped == sample.mapped);
            if !repeated {
                allocations.push((sample.sent_ms, sample.mapped.port()));
            }
        }
        Ok(Self { address, allocator: Allocator::of(&allocations) })
    }

    /// Where the next mappings will be when they are made `lead_ms` after the survey began.
    /// `None` when a counter's window leaves the ports that are searched.
    pub fn aim(&self, lead_ms: u32) -> Option<Aim> {
        match self.allocator {
            Allocator::Point { port } => Some(Aim::Port(port)),
            Allocator::Set(set) => Some(Aim::Set(set)),
            Allocator::Counter { last, at_ms, step, foreign_per_ks } => {
                let (low, high) = window(foreign_milli(foreign_per_ks, lead_ms.saturating_sub(at_ms)));
                let port = |position: u32| {
                    u16::try_from(i64::from(last) + i64::from(step) * i64::from(position))
                        .ok()
                        .filter(|port| *port >= LOWEST_PORT)
                };
                let first = port(low + 1)?;
                port(high + 1)?;
                Some(Aim::Window { first, step, count: (high - low + 1) as u16 })
            }
        }
    }
}

/// Where a peer should look for an endpoint's next mappings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Aim {
    /// The one mapping.
    Port(u16),
    /// The next mapping lands on one of `count` ports from `first` in steps of `step`, and each one
    /// after it a step further. A peer with one mapping sends to all of them. A peer with a counter
    /// of its own aims at the last, which this endpoint's counter has not reached and can walk to.
    Window { first: u16, step: i16, count: u16 },
    /// The next mappings are draws from this set.
    Set(PortSet),
}
impl Aim {
    fn last(first: u16, step: i16, count: u16) -> u16 {
        (i32::from(first) + i32::from(step) * (i32::from(count) - 1)) as u16
    }
}

/// How much one side may spend. Both sides plan with the same budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Budget {
    /// New mappings, each a socket.
    pub mappings: u16,
    /// Packets sent from one retained socket.
    pub packets: u16,
}

/// What one side does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
    /// Send from the one retained socket to one port.
    Send(u16),
    /// Send from the one retained socket to each port of a window.
    Sweep { first: u16, step: i16, count: u16 },
    /// Send from the one retained socket to `count` distinct ports of a set, chosen at random.
    Search { set: PortSet, count: u16 },
    /// Open `sockets` new sockets and send from each to one port.
    Open { sockets: u16, port: u16 },
    /// Open one socket to `port` between two observations, and report the port [`measured`] gives.
    Measure { port: u16 },
    /// On the peer's report, read the counter with one new mapping and open [`walk`] sockets that
    /// send to the reported port; the last of them lands on `to`.
    Walk { to: u16, step: i16 },
}

/// The port of a mapping made between two observations of a counter, when nothing else fell
/// between the three.
pub fn measured(before: u16, after: u16, step: i16) -> Option<u16> {
    (i32::from(after) - i32::from(before) == 2 * i32::from(step))
        .then(|| (i32::from(before) + i32::from(step)) as u16)
}

/// How many sockets carry a counter last seen on `seen` onto `to`. `None` when it is past.
pub fn walk(seen: u16, step: i16, to: u16) -> Option<u16> {
    let distance = i32::from(to) - i32::from(seen);
    (distance % i32::from(step) == 0 && distance / i32::from(step) > 0)
        .then(|| (distance / i32::from(step)) as u16)
}

/// What the side with allocator `local` does about its peer's aim, or `None` when no plan within
/// the budget is worth its cost. `lead_ms` is when its own mappings will be made, and `peer` is the
/// address the aim belongs to.
pub fn part(local: &Model, lead_ms: u32, remote: &Aim, peer: Ipv4Addr, budget: Budget) -> Option<Part> {
    match (local.aim(lead_ms)?, *remote) {
        (Aim::Port(_), Aim::Port(port)) => Some(Part::Send(port)),
        (Aim::Port(_), Aim::Window { first, step, count }) => {
            (count <= budget.packets).then_some(Part::Sweep { first, step, count })
        }
        (Aim::Port(_), Aim::Set(set)) => {
            let count = u32::from(budget.packets).min(set.size()) as u16;
            // The peer's pool is sized for this search; a search too small for any pool is no plan.
            pool(set, count, budget).map(|_| Part::Search { set, count })
        }
        // The peer sends to every port of this side's window, so one mapping is enough.
        (Aim::Window { .. }, Aim::Port(port)) => Some(Part::Open { sockets: 1, port }),
        // Two counters: one is measured and the other walks.
        (Aim::Window { first: own_first, step: own_step, count: own }, Aim::Window { first, step, count }) => {
            let walker = walks((own, own_first, local.address), (count, first, peer))?;
            if own >= budget.mappings || count >= budget.mappings {
                None
            } else if walker {
                Some(Part::Walk { to: Aim::last(own_first, own_step, own), step: own_step })
            } else {
                Some(Part::Measure { port: Aim::last(first, step, count) })
            }
        }
        (Aim::Set(set), Aim::Port(port)) => {
            let search = u32::from(budget.packets).min(set.size()) as u16;
            pool(set, search, budget).map(|sockets| Part::Open { sockets, port })
        }
        // A set against a window or a set: see the bound in the module's head.
        (Aim::Window { .. } | Aim::Set(_), Aim::Set(_)) | (Aim::Set(_), Aim::Window { .. }) => None,
    }
}

/// The probability that the parts of two sides meet. Both leads are measured as in [`Model::aim`],
/// both sides have the same budget, and no foreign allocation falls inside a burst of mappings.
pub fn chance(local: &Model, local_lead_ms: u32, remote: &Model, remote_lead_ms: u32, budget: Budget) -> f64 {
    let covered = |model: &Model, lead_ms: u32| match model.allocator {
        Allocator::Counter { at_ms, foreign_per_ks, .. } => {
            let mean = foreign_milli(foreign_per_ks, lead_ms.saturating_sub(at_ms));
            let (low, high) = window(mean);
            poisson_between(mean as f64 / 1000.0, low, high)
        }
        _ => 1.0,
    };
    let (Some(local_aim), Some(remote_aim)) = (local.aim(local_lead_ms), remote.aim(remote_lead_ms)) else {
        return 0.0;
    };
    let (Some(local_part), Some(_)) = (
        part(local, local_lead_ms, &remote_aim, remote.address, budget),
        part(remote, remote_lead_ms, &local_aim, local.address, budget),
    ) else {
        return 0.0;
    };
    let per_second = |model: &Model| match model.allocator {
        Allocator::Counter { foreign_per_ks, .. } => f64::from(foreign_per_ks) / 1000.0,
        _ => 0.0,
    };
    let met = match (local.allocator, remote.allocator) {
        // Measured against walker: nothing may fall inside the measurement, and the walker's own
        // socket must take the port named, which other traffic races it for.
        (Allocator::Counter { .. }, Allocator::Counter { .. }) => {
            let (walker, measured) = match local_part {
                Part::Walk { .. } => (local, remote),
                _ => (remote, local),
            };
            let spacing = BURST_SPACING_US / 1e6;
            (-2.0 * per_second(measured) * spacing).exp() / (1.0 + per_second(walker) * spacing)
        }
        (Allocator::Point { .. }, Allocator::Set(set)) | (Allocator::Set(set), Allocator::Point { .. }) => {
            let search = u32::from(budget.packets).min(set.size());
            let sockets = pool(set, search as u16, budget).unwrap_or(0);
            1.0 - (1.0 - f64::from(search) / f64::from(set.size())).powi(i32::from(sockets))
        }
        _ => 1.0,
    };
    match (local_part, local.allocator, remote.allocator) {
        (Part::Walk { .. }, ..) => met * covered(local, local_lead_ms),
        (Part::Measure { .. }, ..) => met * covered(remote, remote_lead_ms),
        _ => met * covered(local, local_lead_ms) * covered(remote, remote_lead_ms),
    }
}

/// Which of two counters walks: the one with the wider window, which is the busier, because other
/// traffic walks for it and would spoil a measurement. Equal widths are settled by the first port and
/// then the address, which both sides see alike; two counters alike in all three have no plan.
fn walks(own: (u16, u16, Ipv4Addr), other: (u16, u16, Ipv4Addr)) -> Option<bool> {
    (own != other).then_some(own > other)
}

/// The pool that meets a search of `search` ports in `set` with 99%, when the budget holds it.
fn pool(set: PortSet, search: u16, budget: Budget) -> Option<u16> {
    if search == 0 {
        return None;
    }
    let sockets = (POOL_PRODUCT_X10 * u64::from(set.size())).div_ceil(10 * u64::from(search)).max(1);
    u16::try_from(sockets).ok().filter(|sockets| *sockets <= budget.mappings)
}

/// A counter, when the allocations rise or fall in multiples of one small step.
fn counter(allocations: &[(u32, u16)]) -> Option<Allocator> {
    let (&(first_ms, _), &(last_ms, last)) = (allocations.first()?, allocations.last()?);
    let differences: Vec<i32> =
        allocations.windows(2).map(|pair| i32::from(pair[1].1) - i32::from(pair[0].1)).collect();
    let sign = differences.first()?.signum();
    if sign == 0 || differences.iter().any(|difference| difference.signum() != sign) {
        return None;
    }
    let step = differences.iter().fold(0, |divisor, difference| gcd(divisor, difference.unsigned_abs()));
    let foreign: u64 = differences.iter().map(|difference| u64::from(difference.unsigned_abs() / step - 1)).sum();
    // Equal steps are a counter with three allocations, as before. Unequal steps are told from
    // chance by their number (five rise or fall together by chance once in sixty) and by the
    // traffic they would imply.
    let elapsed_ms = u64::from(last_ms - first_ms).max(1);
    let foreign_per_ks = foreign * 1_000_000 / elapsed_ms;
    let plausible = match foreign {
        0 => allocations.len() >= 3,
        _ => allocations.len() >= 5 && foreign_per_ks <= MAX_FOREIGN_PER_SECOND * 1_000,
    };
    (step <= MAX_STEP && plausible).then(|| Allocator::Counter {
        last,
        at_ms: last_ms,
        step: sign as i16 * step as i16,
        foreign_per_ks: foreign_per_ks as u32,
    })
}

/// The set the allocations were drawn from: a port set they all share, or the span they cover.
fn port_set(allocations: &[(u32, u16)]) -> PortSet {
    let ports = || allocations.iter().map(|&(_, port)| port);
    let distinct = {
        let mut seen: Vec<u16> = ports().collect();
        seen.sort_unstable();
        seen.dedup();
        seen.len() as u32
    };
    for (offset, length) in PORT_SET_SHAPES {
        if u32::from(length) * distinct.saturating_sub(1) < PORT_SET_EVIDENCE_BITS {
            continue;
        }
        let free = 16 - offset - length;
        let Some(&(_, sample)) = allocations.first() else { break };
        let psid = (sample >> free) & ((1 << length) - 1);
        let set = PortSet::Shared { offset, length, psid };
        if ports().all(|port| set.contains(port)) {
            return set;
        }
    }
    PortSet::Span {
        low: ports().min().unwrap_or(LOWEST_PORT).max(LOWEST_PORT),
        high: ports().max().unwrap_or(u16::MAX),
    }
}

/// Foreign allocations expected in `elapsed_ms`, in thousandths.
fn foreign_milli(foreign_per_ks: u32, elapsed_ms: u32) -> u64 {
    u64::from(foreign_per_ks) * u64::from(elapsed_ms) / 1_000
}

/// The foreign allocations a window covers, lowest and highest, for a mean in thousandths.
fn window(mean_milli: u64) -> (u32, u32) {
    // The half width is the least h with h² >= deviations² · mean, and the mean counts as a half
    // at least, so a quiet counter still gets a window of four.
    let spread = WINDOW_DEVIATIONS_SQUARED_X100 * mean_milli.max(500);
    let mut half = 0u64;
    while half * half * 100_000 < spread {
        half += 1;
    }
    let centre = mean_milli / 1_000;
    (centre.saturating_sub(half) as u32, (centre + half) as u32)
}

/// The Poisson mass on `low..=high`, summed in logarithms so that a large mean does not underflow.
fn poisson_between(mean: f64, low: u32, high: u32) -> f64 {
    if mean <= 0.0 {
        return if low == 0 { 1.0 } else { 0.0 };
    }
    let mut log_term = -mean;
    let mut total = 0.0;
    for count in 0..=high {
        if count >= low {
            total += log_term.exp();
        }
        log_term += mean.ln() - f64::from(count + 1).ln();
    }
    total
}

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 { a } else { gcd(b, a % b) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WAN: Ipv4Addr = Ipv4Addr::new(203, 0, 113, 7);
    const BUDGET: Budget = Budget { mappings: 256, packets: 1024 };
    const PEER: Ipv4Addr = Ipv4Addr::new(198, 51, 100, 200);

    /// One sample for each port, from sockets and observers in turn, 20 ms apart.
    fn survey(sockets: u8, ports: &[u16]) -> Vec<Sample> {
        ports
            .iter()
            .enumerate()
            .map(|(index, port)| Sample {
                socket: index as u8 % sockets,
                observer: SocketAddrV4::new(Ipv4Addr::new(198, 51, 100, 1 + (index / sockets as usize) as u8), 3478),
                sent_ms: index as u32 * 20,
                mapped: SocketAddrV4::new(WAN, *port),
            })
            .collect()
    }
    fn model(sockets: u8, ports: &[u16]) -> Model {
        Model::read(&survey(sockets, ports)).unwrap()
    }

    #[test]
    fn reads_a_point_a_counter_and_a_set() {
        assert_eq!(model(1, &[40_000, 40_000, 40_000]).allocator, Allocator::Point { port: 40_000 });
        assert_eq!(
            model(1, &[40_000, 40_002, 40_004]).allocator,
            Allocator::Counter { last: 40_004, at_ms: 40, step: 2, foreign_per_ks: 0 }
        );
        assert_eq!(
            model(1, &[40_000, 39_999, 39_998]).allocator,
            Allocator::Counter { last: 39_998, at_ms: 40, step: -1, foreign_per_ks: 0 }
        );
        // Other traffic took 2, 0, 3, 1 and 1 allocations between six of ours: 7 in 100 ms.
        assert_eq!(
            model(2, &[40_000, 40_003, 40_004, 40_008, 40_010, 40_012]).allocator,
            Allocator::Counter { last: 40_012, at_ms: 100, step: 1, foreign_per_ks: 70_000 }
        );
        assert_eq!(
            model(2, &[51_200, 60_011, 50_333, 64_100, 57_000, 52_048]).allocator,
            Allocator::Set(PortSet::Span { low: 50_333, high: 64_100 })
        );
    }

    #[test]
    fn unequal_steps_need_five_allocations_and_plausible_traffic() {
        // Three ports that rise by chance are a set, and so are six that rise by thousands.
        assert!(matches!(model(1, &[40_000, 40_003, 40_004]).allocator, Allocator::Set(_)));
        assert!(matches!(
            model(2, &[1_500, 9_000, 20_000, 31_000, 44_000, 60_000]).allocator,
            Allocator::Set(_)
        ));
        // A fall of half the port space is no counter, and reading it does not overflow.
        assert!(matches!(model(1, &[40_000, 7_232]).allocator, Allocator::Set(_)));
        assert!(poisson_between(900.0, 800, 1_000) > 0.998);
    }

    #[test]
    fn refuses_one_observer_and_two_addresses() {
        let mut samples = survey(1, &[40_000, 40_000]);
        samples[1].observer = samples[0].observer;
        assert_eq!(Model::read(&samples), Err(Unusable::TooFew));
        // Two sockets that each asked one observer compare nothing either.
        assert_eq!(Model::read(&survey(2, &[40_000, 40_003])[..]).map(|_| ()), Err(Unusable::TooFew));
        let mut samples = survey(1, &[40_000, 40_001, 40_002]);
        samples[2].mapped = SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 8), 40_002);
        assert_eq!(Model::read(&samples), Err(Unusable::AddressesDiffer));
    }

    #[test]
    fn recognises_a_port_set_and_walks_it() {
        // RFC 7597 with a four-bit offset and an eight-bit identifier: fifteen runs of sixteen ports.
        let set = PortSet::Shared { offset: 4, length: 8, psid: 0x5a };
        assert_eq!(set.size(), 240);
        let ports: Vec<u16> = (0..set.size()).map(|index| set.nth(index)).collect();
        assert!(ports.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(ports.iter().all(|port| set.contains(*port) && *port >= 4_096));
        assert_eq!((0..=u16::MAX).filter(|port| set.contains(*port)).count(), 240);
        assert_eq!(model(1, &[ports[200], ports[17], ports[99]]).allocator, Allocator::Set(set));
        // Two samples agree on eight bits once in 256 by chance, so they stay a span.
        assert!(matches!(model(1, &[ports[200], ports[17]]).allocator, Allocator::Set(PortSet::Span { .. })));
    }

    #[test]
    fn a_window_holds_the_mass_of_its_mean() {
        for (mean, sockets) in [(0, 4), (2, 8), (4, 12), (8, 19), (16, 29), (64, 55)] {
            let (low, high) = window(mean * 1_000);
            assert_eq!(high - low + 1, sockets, "mean {mean}");
            assert!(poisson_between(mean as f64, low, high) > 0.998, "mean {mean}");
        }
    }

    #[test]
    fn a_counter_aims_past_the_traffic_expected_before_its_mappings() {
        // 70 foreign allocations a second, mappings made 200 ms after the last sample: a mean of 14.
        let counter = model(2, &[40_000, 40_003, 40_004, 40_008, 40_010, 40_012]);
        let (low, high) = window(14_000);
        assert_eq!(
            counter.aim(300),
            Some(Aim::Window { first: 40_012 + 1 + low as u16, step: 1, count: (high - low + 1) as u16 })
        );
        // A counter that would run past the last port has no aim.
        assert_eq!(model(1, &[65_520, 65_524, 65_528]).aim(40), None);
    }

    #[test]
    fn each_pair_has_its_part() {
        let point = model(1, &[40_000, 40_000, 40_000]);
        let counter = model(1, &[50_000, 50_001, 50_002]);
        let set = model(2, &[51_200, 60_011, 50_333, 64_100, 57_000, 52_048]);
        let aim = |model: &Model| model.aim(40).unwrap();
        assert_eq!(part(&point, 40, &aim(&point), PEER, BUDGET), Some(Part::Send(40_000)));
        // A point sends to every port of a counter's window and the counter opens one mapping.
        assert_eq!(part(&point, 40, &aim(&counter), PEER, BUDGET), Some(Part::Sweep { first: 50_003, step: 1, count: 4 }));
        assert_eq!(part(&counter, 40, &aim(&point), PEER, BUDGET), Some(Part::Open { sockets: 1, port: 40_000 }));
        // Two counters: the busier walks onto the last port of its own window and the other
        // measures one mapping to it. Alike in window and port, the higher address walks.
        let busy = model(2, &[40_000, 40_003, 40_004, 40_008, 40_010, 40_012]);
        let busy_aim = busy.aim(300).unwrap();
        let top = match busy_aim {
            Aim::Window { first, count, .. } => first + count - 1,
            _ => unreachable!(),
        };
        assert_eq!(part(&busy, 300, &aim(&counter), PEER, BUDGET), Some(Part::Walk { to: top, step: 1 }));
        assert_eq!(part(&counter, 40, &busy_aim, PEER, BUDGET), Some(Part::Measure { port: top }));
        assert_eq!(part(&counter, 40, &aim(&counter), PEER, BUDGET), Some(Part::Walk { to: 50_006, step: 1 }));
        assert_eq!(part(&counter, 40, &aim(&counter), Ipv4Addr::new(203, 0, 113, 9), BUDGET), Some(Part::Measure { port: 50_006 }));
        assert_eq!(part(&counter, 40, &aim(&counter), WAN, BUDGET), None);
        // The measured port is the one between two observations a step apart on each side; the
        // walker opens as many sockets as steps remain.
        assert_eq!(measured(41_000, 41_002, 1), Some(41_001));
        assert_eq!(measured(41_000, 41_003, 1), None);
        assert_eq!(walk(50_002, 1, 50_006), Some(4));
        assert_eq!(walk(50_006, 1, 50_006), None);
        assert_eq!(walk(50_010, -2, 50_004), Some(3));
        // A point searches the span the survey saw, and the set's pool is sized for that search.
        let span = PortSet::Span { low: 50_333, high: 64_100 };
        assert_eq!(part(&point, 40, &aim(&set), PEER, BUDGET), Some(Part::Search { set: span, count: 1024 }));
        assert_eq!(part(&set, 40, &aim(&point), PEER, BUDGET), Some(Part::Open { sockets: 62, port: 40_000 }));
        // A set has no part against a counter or another set.
        assert_eq!(part(&set, 40, &aim(&counter), PEER, BUDGET), None);
        assert_eq!(part(&counter, 40, &aim(&set), PEER, BUDGET), None);
        assert_eq!(part(&set, 40, &aim(&set), PEER, BUDGET), None);
    }

    #[test]
    fn two_counters_meet_for_every_traffic_inside_their_windows() {
        // Socket i of a side lands on position 1 + foreign + i; the peer aims at the window's last.
        let (low, high) = window(8_000);
        let sockets = high - low + 1;
        for foreign in low..=high {
            assert!((0..sockets).any(|socket| 1 + foreign + socket == high + 1));
        }
        assert!(!(0..sockets).any(|socket| 1 + (high + 1) + socket == high + 1));
    }

    #[test]
    fn chances_follow_the_allocators() {
        let point = model(1, &[40_000, 40_000, 40_000]);
        let quiet = model(1, &[50_000, 50_001, 50_002]);
        let busy = model(2, &[40_000, 40_003, 40_004, 40_008, 40_010, 40_012]);
        let wide = model(2, &[1_200, 60_011, 30_333, 64_100, 17_000, 52_048]);
        let block = model(2, &[20_500, 21_900, 20_480, 22_500, 21_000, 22_048]);
        assert_eq!(chance(&point, 40, &point, 40, BUDGET), 1.0);
        assert!(chance(&point, 300, &busy, 300, BUDGET) > 0.998);
        // Seventy foreign allocations a second cost the walker's race about 1.4%.
        assert!((0.980..0.990).contains(&chance(&quiet, 40, &busy, 300, BUDGET)));
        assert_eq!(chance(&busy, 300, &busy, 300, BUDGET), 0.0);
        // The widest span needs a pool beyond the budget's mappings; a block of 2,021 ports needs ten.
        assert_eq!(chance(&point, 40, &wide, 40, BUDGET), 0.0);
        assert!(chance(&point, 40, &wide, 40, Budget { mappings: 512, packets: 1024 }) > 0.98);
        assert_eq!(part(&block, 40, &Aim::Port(40_000), PEER, BUDGET), Some(Part::Open { sockets: 10, port: 40_000 }));
        assert!(chance(&point, 40, &block, 40, BUDGET) > 0.99);
        assert_eq!(chance(&wide, 40, &busy, 300, BUDGET), 0.0);
    }
}
