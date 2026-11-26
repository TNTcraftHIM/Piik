//! What a survey tells about a NAT's port allocator, and where its next mappings will be.
//!
//! A survey is a table of samples: which socket asked which observer when, and the address the
//! observer saw. This module reads one of three allocators from it: a point (the mapping does not
//! depend on the destination), cursors (a new mapping lands one step past one of a few counters,
//! which other traffic advances too), or draws from a set of ports. [`Model::aim`] turns the
//! allocator into ports a peer can use, [`part`] says what one side does about the other's aim, and
//! [`chance`] gives the probability that the two parts meet.
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
/// A cursor's step is at most this, as in the three-sample rule this module replaces.
const MAX_STEP: u32 = 16;
/// A new port joins a cursor when it lies at most this far past the cursor's last port. Two of
/// eighteen uniform draws from 64,512 ports come this close about once in three surveys, and three
/// in a row about once in ten thousand, which is why a cursor is believed at three.
const MAX_GAP: i32 = 32;
const BELIEVED: usize = 3;
/// One busy counter leaves gaps wider than [`MAX_GAP`]. It is told from chance by five mappings
/// that all rise or all fall, and by traffic no heavier than this many mappings a second.
const BUSY_MAPPINGS: usize = 5;
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

/// One counter of an allocator: the next mapping that lands on it takes `last + step`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cursor {
    pub last: u16,
    /// When `last` was seen, in milliseconds since the survey began.
    pub at_ms: u32,
    pub step: i16,
    /// How many of the survey's mappings landed on it.
    pub landings: u16,
    /// Mappings other traffic took from it, in a thousand seconds.
    pub foreign_per_ks: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Allocator {
    /// One mapping whatever the destination.
    Point { port: u16 },
    /// Each new mapping lands one step past one of these, the most used first. A plain counter is
    /// one cursor; a carrier NAT that keeps a port range for each of its workers shows several.
    Cursors(Vec<Cursor>),
    /// Each new mapping is a draw from a set.
    Set(PortSet),
}
impl Allocator {
    /// The allocator behind new mappings, each given as its time in milliseconds and its port, in
    /// the order they were made.
    pub fn of(allocations: &[(u32, u16)]) -> Self {
        cursors(allocations).map_or_else(|| Self::Set(port_set(allocations)), Self::Cursors)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
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
    /// `None` when no cursor's window stays inside the ports that are searched.
    pub fn aim(&self, lead_ms: u32) -> Option<Aim> {
        match &self.allocator {
            Allocator::Point { port } => Some(Aim::Port(*port)),
            Allocator::Set(set) => Some(Aim::Set(*set)),
            Allocator::Cursors(cursors) => {
                let windows: Vec<Window> = cursors.iter().filter_map(|cursor| cursor.window(lead_ms)).collect();
                (!windows.is_empty()).then_some(Aim::Windows(windows))
            }
        }
    }
}

impl Cursor {
    /// The ports the next mapping on this cursor can take, for the traffic expected by `lead_ms`.
    fn window(&self, lead_ms: u32) -> Option<Window> {
        let (low, high) = window(foreign_milli(self.foreign_per_ks, lead_ms.saturating_sub(self.at_ms)));
        let port = |position: u32| {
            u16::try_from(i64::from(self.last) + i64::from(self.step) * i64::from(position))
                .ok()
                .filter(|port| *port >= LOWEST_PORT)
        };
        let first = port(low + 1)?;
        port(high + 1)?;
        Some(Window { first, step: self.step, count: (high - low + 1) as u16 })
    }
    /// The chance that this cursor's traffic stays inside its window.
    fn covered(&self, lead_ms: u32) -> f64 {
        let mean = foreign_milli(self.foreign_per_ks, lead_ms.saturating_sub(self.at_ms));
        let (low, high) = window(mean);
        poisson_between(mean as f64 / 1000.0, low, high)
    }
}

/// `count` ports from `first` in steps of `step`: the next mapping on a cursor lands on one of them,
/// and each one after it a step further.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Window {
    pub first: u16,
    pub step: i16,
    pub count: u16,
}
impl Window {
    pub fn last(&self) -> u16 {
        (i32::from(self.first) + i32::from(self.step) * (i32::from(self.count) - 1)) as u16
    }
}

/// Where a peer should look for an endpoint's next mappings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Aim {
    /// The one mapping.
    Port(u16),
    /// One window for each cursor, the most used first. A peer with one mapping sends to all of
    /// them. A peer with cursors of its own aims at the last port of the first window, which this
    /// endpoint's cursor has not reached and can walk to.
    Windows(Vec<Window>),
    /// The next mappings are draws from this set.
    Set(PortSet),
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
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Part {
    /// Send from the one retained socket to one port.
    Send(u16),
    /// Send from the one retained socket to each port of these windows.
    Sweep(Vec<Window>),
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
    match (local.aim(lead_ms)?, remote) {
        (Aim::Port(_), Aim::Port(port)) => Some(Part::Send(*port)),
        (Aim::Port(_), Aim::Windows(windows)) => {
            let swept = swept(windows, budget);
            (!swept.is_empty()).then(|| Part::Sweep(swept.to_vec()))
        }
        (Aim::Port(_), Aim::Set(set)) => {
            let count = u32::from(budget.packets).min(set.size()) as u16;
            // The peer's pool is sized for this search; a search too small for any pool is no plan.
            pool(*set, count, budget).map(|_| Part::Search { set: *set, count })
        }
        // The peer sends to every port of this side's windows, so one mapping is enough.
        (Aim::Windows(_), Aim::Port(port)) => Some(Part::Open { sockets: 1, port: *port }),
        (Aim::Windows(own), Aim::Windows(theirs)) => {
            let (mine, yours) = (own[0], theirs[0]);
            if let ([_], [_]) = (&own[..], &theirs[..]) {
                // Two plain counters: one is measured and the other walks.
                let walker = walks((mine.count, mine.first, local.address), (yours.count, yours.first, peer))?;
                (mine.count < budget.mappings && yours.count < budget.mappings).then(|| match walker {
                    true => Part::Walk { to: mine.last(), step: mine.step },
                    false => Part::Measure { port: yours.last() },
                })
            } else {
                // Several cursors on a side: a socket cannot choose the cursor it lands on, so each
                // side opens enough for its most used cursor to reach its window's last port.
                let sockets = landings(local, mine.count)?;
                (sockets <= budget.mappings).then_some(Part::Open { sockets, port: yours.last() })
            }
        }
        (Aim::Set(set), Aim::Port(port)) => {
            let search = u32::from(budget.packets).min(set.size()) as u16;
            pool(set, search, budget).map(|sockets| Part::Open { sockets, port: *port })
        }
        // A set against windows or a set: see the bound in the module's head.
        (Aim::Windows(_) | Aim::Set(_), Aim::Set(_)) | (Aim::Set(_), Aim::Windows(_)) => None,
    }
}

/// The probability that the parts of two sides meet. Both leads are measured as in [`Model::aim`],
/// both sides have the same budget, and no foreign allocation falls inside a burst of mappings
/// except where a walker races for its port.
pub fn chance(local: &Model, local_lead_ms: u32, remote: &Model, remote_lead_ms: u32, budget: Budget) -> f64 {
    let (Some(local_aim), Some(remote_aim)) = (local.aim(local_lead_ms), remote.aim(remote_lead_ms)) else {
        return 0.0;
    };
    let (Some(local_part), Some(remote_part)) = (
        part(local, local_lead_ms, &remote_aim, remote.address, budget),
        part(remote, remote_lead_ms, &local_aim, local.address, budget),
    ) else {
        return 0.0;
    };
    // One side of the pair as the other's part meets it.
    let side = |model: &Model, lead_ms: u32, own: &Part, other: &Part| match (&model.allocator, own, other) {
        // The peer sweeps some of this side's windows: the mapping must land on a swept cursor
        // and that cursor's traffic must stay inside its window.
        (Allocator::Cursors(cursors), _, Part::Sweep(swept)) => {
            let total: f64 = cursors.iter().map(|cursor| f64::from(cursor.landings)).sum();
            cursors.iter().take(swept.len()).map(|cursor| f64::from(cursor.landings) / total * cursor.covered(lead_ms)).sum()
        }
        // Measured: nothing may fall inside the measurement.
        (Allocator::Cursors(cursors), Part::Measure { .. }, _) => (-2.0 * per_second(&cursors[0]) * BURST_SPACING_US / 1e6).exp(),
        // Walker: its traffic must not have passed the port named, and its own socket must take
        // the port, which other traffic races it for.
        (Allocator::Cursors(cursors), Part::Walk { .. }, _) => {
            cursors[0].covered(lead_ms) / (1.0 + per_second(&cursors[0]) * BURST_SPACING_US / 1e6)
        }
        // Several cursors: enough of the sockets opened must land on the most used one.
        (Allocator::Cursors(cursors), Part::Open { sockets, .. }, Part::Open { .. }) => {
            let total: f64 = cursors.iter().map(|cursor| f64::from(cursor.landings)).sum();
            let needed = cursors[0].window(lead_ms).map_or(u16::MAX, |window| window.count);
            cursors[0].covered(lead_ms) * binomial_at_least(*sockets, f64::from(cursors[0].landings) / total, needed)
        }
        (Allocator::Set(set), Part::Open { sockets, .. }, Part::Search { count, .. }) => {
            1.0 - (1.0 - f64::from(*count) / f64::from(set.size())).powi(i32::from(*sockets))
        }
        _ => 1.0,
    };
    side(local, local_lead_ms, &local_part, &remote_part) * side(remote, remote_lead_ms, &remote_part, &local_part)
}

/// The windows a peer's packets reach, in order, within the budget.
fn swept(windows: &[Window], budget: Budget) -> &[Window] {
    let mut packets = 0u32;
    let reached = windows.iter().take_while(|window| {
        packets += u32::from(window.count);
        packets <= u32::from(budget.packets)
    });
    &windows[..reached.count()]
}

/// The sockets after which the most used cursor has very likely taken `needed` of them: twice
/// `needed` over its share of landings, which leaves four of nineteen short once in sixty.
fn landings(model: &Model, needed: u16) -> Option<u16> {
    let Allocator::Cursors(cursors) = &model.allocator else { return None };
    let total: u32 = cursors.iter().map(|cursor| u32::from(cursor.landings)).sum();
    u16::try_from((u32::from(needed) * total * 2).div_ceil(u32::from(cursors[0].landings))).ok()
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

/// The cursors behind allocations in the order they were made, the most used first, or `None`
/// when the ports are draws from a set.
fn cursors(allocations: &[(u32, u16)]) -> Option<Vec<Cursor>> {
    // Each port joins the cursor it lies closest past, or begins one.
    let mut runs: Vec<Vec<(u32, u16)>> = Vec::new();
    for &(at_ms, port) in allocations {
        let joined = runs
            .iter()
            .enumerate()
            .filter_map(|(index, run)| {
                let gap = i32::from(port) - i32::from(run[run.len() - 1].1);
                let direction = run.get(1).map_or(gap.signum(), |second| (i32::from(second.1) - i32::from(run[0].1)).signum());
                (gap != 0 && gap.abs() <= MAX_GAP && gap.signum() == direction).then_some((gap.abs(), index))
            })
            .min();
        match joined {
            Some((_, index)) => runs[index].push((at_ms, port)),
            None => runs.push(vec![(at_ms, port)]),
        }
    }
    let believed: usize = runs.iter().map(Vec::len).filter(|length| *length >= BELIEVED).sum();
    if believed * 2 < allocations.len() || believed == 0 {
        // Not a few quiet cursors. One busy counter is the other shape with an order in it.
        return busy(allocations).map(|cursor| vec![cursor]);
    }
    // A port seen once may be a cursor of its own, so it is kept with the step the others have.
    let step = runs.iter().filter(|run| run.len() >= BELIEVED).map(|run| cursor(run, 1).step).next().unwrap_or(1);
    let mut cursors: Vec<Cursor> = runs.iter().map(|run| cursor(run, step)).collect();
    cursors.sort_by(|a, b| b.landings.cmp(&a.landings).then(b.at_ms.cmp(&a.at_ms)));
    Some(cursors)
}

/// The cursor a run of ports shows; `lone` is the step given to a run of one.
fn cursor(run: &[(u32, u16)], lone: i16) -> Cursor {
    let (first_ms, _) = run[0];
    let (at_ms, last) = run[run.len() - 1];
    let differences: Vec<i32> = run.windows(2).map(|pair| i32::from(pair[1].1) - i32::from(pair[0].1)).collect();
    let divisor = differences.iter().fold(0, |divisor, difference| gcd(divisor, difference.unsigned_abs()));
    let step = match differences.first() {
        None => i32::from(lone),
        Some(first) => first.signum() * if divisor <= MAX_STEP { divisor as i32 } else { 1 },
    };
    let foreign: u64 = differences.iter().map(|difference| u64::from((difference / step - 1).unsigned_abs())).sum();
    Cursor {
        last,
        at_ms,
        step: step as i16,
        landings: run.len() as u16,
        foreign_per_ks: (foreign * 1_000_000 / u64::from(at_ms - first_ms).max(1)) as u32,
    }
}

/// One counter under heavy traffic, when the allocations all rise or all fall in multiples of a
/// small step and imply traffic a counter can have.
fn busy(allocations: &[(u32, u16)]) -> Option<Cursor> {
    let differences: Vec<i32> =
        allocations.windows(2).map(|pair| i32::from(pair[1].1) - i32::from(pair[0].1)).collect();
    let sign = differences.first()?.signum();
    if allocations.len() < BUSY_MAPPINGS || sign == 0 || differences.iter().any(|difference| difference.signum() != sign) {
        return None;
    }
    let divisor = differences.iter().fold(0, |divisor, difference| gcd(divisor, difference.unsigned_abs()));
    let found = cursor(allocations, 1);
    (divisor <= MAX_STEP && u64::from(found.foreign_per_ks) <= MAX_FOREIGN_PER_SECOND * 1_000).then_some(found)
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

fn per_second(cursor: &Cursor) -> f64 {
    f64::from(cursor.foreign_per_ks) / 1000.0
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

/// The chance that at least `needed` of `trials` succeed, each with probability `share`.
fn binomial_at_least(trials: u16, share: f64, needed: u16) -> f64 {
    if needed > trials {
        return 0.0;
    }
    let mut term = (1.0 - share).powi(i32::from(trials));
    let mut below = 0.0;
    for successes in 0..needed {
        below += term;
        term *= f64::from(trials - successes) / f64::from(successes + 1) * share / (1.0 - share).max(f64::MIN_POSITIVE);
    }
    (1.0 - below).clamp(0.0, 1.0)
}

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 { a } else { gcd(b, a % b) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WAN: Ipv4Addr = Ipv4Addr::new(203, 0, 113, 7);
    const PEER: Ipv4Addr = Ipv4Addr::new(198, 51, 100, 200);
    const BUDGET: Budget = Budget { mappings: 256, packets: 1024 };

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
    fn counter(last: u16, at_ms: u32, step: i16, landings: u16, foreign_per_ks: u32) -> Allocator {
        Allocator::Cursors(vec![Cursor { last, at_ms, step, landings, foreign_per_ks }])
    }

    #[test]
    fn reads_a_point_a_counter_and_a_set() {
        assert_eq!(model(1, &[40_000, 40_000, 40_000]).allocator, Allocator::Point { port: 40_000 });
        assert_eq!(model(1, &[40_000, 40_002, 40_004]).allocator, counter(40_004, 40, 2, 3, 0));
        assert_eq!(model(1, &[40_000, 39_999, 39_998]).allocator, counter(39_998, 40, -1, 3, 0));
        // Other traffic took 2, 0, 3, 1 and 1 allocations between six of ours: 7 in 100 ms.
        assert_eq!(model(2, &[40_000, 40_003, 40_004, 40_008, 40_010, 40_012]).allocator, counter(40_012, 100, 1, 6, 70_000));
        assert_eq!(
            model(2, &[51_200, 60_011, 50_333, 64_100, 57_000, 52_048]).allocator,
            Allocator::Set(PortSet::Span { low: 50_333, high: 64_100 })
        );
    }

    #[test]
    fn a_busy_counter_needs_five_mappings_and_plausible_traffic() {
        // Gaps of 40 to 90 are too wide for a quiet cursor, and six that rise together are one
        // counter under about two thousand mappings a second.
        assert_eq!(
            model(2, &[40_000, 40_040, 40_100, 40_190, 40_230, 40_300]).allocator,
            counter(40_300, 100, 10, 6, 250_000)
        );
        // Four are too few, and six that rise by thousands imply traffic no counter has.
        assert!(matches!(model(2, &[40_000, 40_040, 40_100, 40_190]).allocator, Allocator::Set(_)));
        assert!(matches!(
            model(2, &[1_500, 9_000, 20_000, 31_000, 44_000, 60_000]).allocator,
            Allocator::Set(_)
        ));
        // A fall of half the port space is no counter, and reading it does not overflow.
        assert!(matches!(model(1, &[40_000, 7_232]).allocator, Allocator::Set(_)));
        assert!(poisson_between(900.0, 800, 1_000) > 0.998);
    }

    #[test]
    fn reads_the_cursors_of_a_carrier_network() {
        // Ports a carrier network gave on 2026-11-26, in the order they were made.
        let ports = [14_156, 34_188, 6_253, 63_295, 34_189, 63_296, 6_254, 63_297, 34_190, 63_298, 63_299, 63_300, 34_191, 21_019];
        let allocations: Vec<(u32, u16)> = ports.iter().enumerate().map(|(index, port)| (index as u32 * 400, *port)).collect();
        let Allocator::Cursors(cursors) = Allocator::of(&allocations) else { panic!("not cursors") };
        let seen: Vec<(u16, u16)> = cursors.iter().map(|cursor| (cursor.last, cursor.landings)).collect();
        assert_eq!(seen, [(63_300, 6), (34_191, 4), (6_254, 2), (21_019, 1), (14_156, 1)]);
        assert!(cursors.iter().all(|cursor| cursor.step == 1 && cursor.foreign_per_ks == 0));
        // A peer with one mapping sweeps five windows of four ports and meets every landing.
        let network = Model { address: WAN, allocator: Allocator::Cursors(cursors) };
        let point = model(1, &[40_000, 40_000, 40_000]);
        let aim = network.aim(6_000).unwrap();
        let Some(Part::Sweep(swept)) = part(&point, 40, &aim, WAN, BUDGET) else { panic!("no sweep") };
        assert_eq!(swept.iter().map(|window| (window.first, window.count)).collect::<Vec<_>>(), [(63_301, 4), (34_192, 4), (6_255, 4), (21_020, 4), (14_157, 4)]);
        assert!(chance(&point, 40, &network, 6_000, BUDGET) > 0.998);
        // Two such networks: each opens enough sockets for its most used cursor to reach its window.
        assert_eq!(part(&network, 6_000, &aim, PEER, BUDGET), Some(Part::Open { sockets: 19, port: 63_304 }));
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
        let busy = model(2, &[40_000, 40_003, 40_004, 40_008, 40_010, 40_012]);
        let (low, high) = window(14_000);
        assert_eq!(
            busy.aim(300),
            Some(Aim::Windows(vec![Window { first: 40_012 + 1 + low as u16, step: 1, count: (high - low + 1) as u16 }]))
        );
        // A counter that would run past the last port has no aim.
        assert_eq!(model(1, &[65_520, 65_524, 65_528]).aim(40), None);
    }

    #[test]
    fn each_pair_has_its_part() {
        let point = model(1, &[40_000, 40_000, 40_000]);
        let quiet = model(1, &[50_000, 50_001, 50_002]);
        let set = model(2, &[51_200, 60_011, 50_333, 64_100, 57_000, 52_048]);
        let aim = |model: &Model| model.aim(40).unwrap();
        assert_eq!(part(&point, 40, &aim(&point), PEER, BUDGET), Some(Part::Send(40_000)));
        // A point sends to every port of a counter's window and the counter opens one mapping.
        assert_eq!(part(&point, 40, &aim(&quiet), PEER, BUDGET), Some(Part::Sweep(vec![Window { first: 50_003, step: 1, count: 4 }])));
        assert_eq!(part(&quiet, 40, &aim(&point), PEER, BUDGET), Some(Part::Open { sockets: 1, port: 40_000 }));
        // Two counters: the busier walks onto the last port of its own window and the other
        // measures one mapping to it. Alike in window and port, the higher address walks.
        let busy = model(2, &[40_000, 40_003, 40_004, 40_008, 40_010, 40_012]);
        let Some(Aim::Windows(windows)) = busy.aim(300) else { panic!("no window") };
        let top = windows[0].last();
        assert_eq!(part(&busy, 300, &aim(&quiet), PEER, BUDGET), Some(Part::Walk { to: top, step: 1 }));
        assert_eq!(part(&quiet, 40, &busy.aim(300).unwrap(), PEER, BUDGET), Some(Part::Measure { port: top }));
        assert_eq!(part(&quiet, 40, &aim(&quiet), PEER, BUDGET), Some(Part::Walk { to: 50_006, step: 1 }));
        assert_eq!(part(&quiet, 40, &aim(&quiet), Ipv4Addr::new(203, 0, 113, 9), BUDGET), Some(Part::Measure { port: 50_006 }));
        assert_eq!(part(&quiet, 40, &aim(&quiet), WAN, BUDGET), None);
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
        assert_eq!(part(&set, 40, &aim(&quiet), PEER, BUDGET), None);
        assert_eq!(part(&quiet, 40, &aim(&set), PEER, BUDGET), None);
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
        assert!((binomial_at_least(14, 6.0 / 14.0, 4) - 0.914).abs() < 0.005);
        assert!(binomial_at_least(19, 6.0 / 14.0, 4) > 0.98);
    }
}
