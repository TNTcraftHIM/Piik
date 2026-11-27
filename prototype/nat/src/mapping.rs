//! What a survey tells about a NAT's port allocator, and where its next mappings will be.
//!
//! A survey is a table of samples: which socket asked which observer when, and the address the
//! observer saw. This module reads one of three allocators from it: a point (the mapping does not
//! depend on the destination), cursors (a new mapping lands one step past one of a few counters,
//! which other traffic advances too), or draws from a set of ports. [`Model::aim`] turns the
//! allocator into ports a peer can use, [`part`] says what one side does about the other's aim, and
//! [`chance`] gives the probability that the two parts meet.
//!
//! What is read is a hypothesis about the allocator, and the probabilities say so: a span drawn by
//! `n` ports holds the next draw with `(n-1)/(n+1)`, and a cursor's traffic is predicted from what
//! the survey saw of it, with the uncertainty of a short watch.
//!
//! One bound holds for every plan. A mapping bound to one destination port meets only a peer mapping
//! aimed at exactly it, so with `m` and `n` such mappings drawn from sets of `r` and `s` ports the
//! expected number of meetings is `m·n / (r·s)`. Two set allocators therefore have no part here.
//!
//! An endpoint computes its own aim and sends it, and its peer acts on those numbers, so no two
//! machines have to agree on a floating-point result.
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
/// A window leaves this much of the predicted traffic outside at each end.
const TAIL: f64 = 0.0005;
/// A cursor whose window would be wider than this has no window: its traffic is not known well
/// enough, or is too heavy, to aim at.
const WIDEST_WINDOW: u32 = 512;
/// Two packets of one burst leave this many microseconds apart; a foreign allocation that falls
/// between them moves a mapping off the port it was meant for.
const BURST_SPACING_US: f64 = 200.0;
/// A pool is sized to miss its search no more often than this.
const POOL_MISS: f64 = 0.01;

/// One answer of a survey.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sample {
    pub socket: u8,
    /// The port the socket is bound to on this machine.
    pub local_port: u16,
    pub observer: SocketAddrV4,
    /// Milliseconds since the survey began.
    pub sent_ms: u32,
    pub mapped: SocketAddrV4,
}

/// The ports a set allocator draws from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PortSet {
    /// The span of the `seen` distinct ports a survey saw.
    Span { low: u16, high: u16, seen: u16 },
    /// An RFC 7597 port set: `offset` leading bits that are never all zero, then `length` bits equal
    /// to `psid`, then the rest free.
    Shared { offset: u8, length: u8, psid: u16 },
}
impl PortSet {
    pub fn size(&self) -> u32 {
        match *self {
            Self::Span { low, high, .. } => u32::from(high) - u32::from(low) + 1,
            Self::Shared { offset, length, .. } => ((1 << offset) - 1) << (16 - offset - length),
        }
    }
    pub fn contains(&self, port: u16) -> bool {
        match *self {
            Self::Span { low, high, .. } => (low..=high).contains(&port),
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
    /// The chance that the next draw lies in the set. Of `n + 1` exchangeable draws the last is
    /// the lowest or the highest with probability `2/(n+1)`, so a span holds it with the rest. A
    /// port set is believed on evidence worth one in 2^16.
    pub fn holds(&self) -> f64 {
        match *self {
            Self::Span { seen, .. } => (f64::from(seen) - 1.0).max(0.0) / (f64::from(seen) + 1.0),
            Self::Shared { .. } => 1.0 - 1.0 / 65_536.0,
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
    /// Mappings other traffic took from it while the survey watched it for `watched_ms`. A cursor
    /// seen once is given what the others showed together.
    pub foreign: u16,
    pub watched_ms: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Allocator {
    /// One mapping whatever the destination, on the socket's own port when `preserved`.
    Point { port: u16, preserved: bool },
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
            let preserved = ordered.iter().all(|sample| sample.mapped.port() == sample.local_port);
            return Ok(Self { address, allocator: Allocator::Point { port: ordered[0].mapped.port(), preserved } });
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
    /// `None` when no cursor has a window inside the ports that are searched.
    pub fn aim(&self, lead_ms: u32) -> Option<Aim> {
        match &self.allocator {
            Allocator::Point { port, .. } => Some(Aim::Port(*port)),
            Allocator::Set(set) => Some(Aim::Set(*set)),
            Allocator::Cursors(cursors) => {
                let windows: Vec<Window> = windowed(cursors, lead_ms).map(|(_, window)| window).collect();
                (!windows.is_empty()).then_some(Aim::Windows(windows))
            }
        }
    }
}

/// The cursors that have a window at `lead_ms`, each with it, in the allocator's order. The aim and
/// the score both read this list, so a cursor without a window is absent from both.
fn windowed(cursors: &[Cursor], lead_ms: u32) -> impl Iterator<Item = (&Cursor, Window)> {
    cursors.iter().filter_map(move |cursor| Some((cursor, cursor.window(lead_ms)?)))
}

/// The share of a survey's landings that fell on cursors it saw: one less the share that fell on
/// cursors seen once, which estimates how often the next lands on one never seen (Good-Turing).
fn seen(cursors: &[Cursor]) -> f64 {
    let total: f64 = cursors.iter().map(|cursor| f64::from(cursor.landings)).sum();
    let once = cursors.iter().filter(|cursor| cursor.landings == 1).count() as f64;
    1.0 - once / total
}

impl Cursor {
    /// The ports the next mapping on this cursor can take, for the traffic predicted by `lead_ms`.
    fn window(&self, lead_ms: u32) -> Option<Window> {
        let (low, high, _) = predicted(self.foreign, self.watched_ms, lead_ms.saturating_sub(self.at_ms))?;
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
        predicted(self.foreign, self.watched_ms, lead_ms.saturating_sub(self.at_ms)).map_or(0.0, |(_, _, mass)| mass)
    }
    /// The traffic the survey saw, in mappings a second.
    pub fn per_second(&self) -> f64 {
        f64::from(self.foreign) * 1000.0 / f64::from(self.watched_ms.max(1))
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
    /// The port one step past the window, when it is a port that is searched.
    pub fn past(&self) -> Option<u16> {
        u16::try_from(i32::from(self.last()) + i32::from(self.step)).ok().filter(|port| *port >= LOWEST_PORT)
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
    /// send to the reported port; the last of them lands on `to`. The reading takes a port of the
    /// counter itself, so `to` is one step past the window.
    Walk { to: u16, step: i16 },
}

/// The port of a mapping made between two observations of a counter, when nothing else fell
/// between the three. The three must be known to have been allocated in that order: the order of
/// sending does not prove it.
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

/// What the side with allocator `local` does about its peer's aim. `own` is the aim it sent, and
/// `peer` the address the other aim belongs to. `None` is an abstention: this module has no plan
/// for the pair, which says nothing about whether ordinary connectivity checks would succeed.
pub fn part(local: &Model, own: &Aim, remote: &Aim, peer: Ipv4Addr, budget: Budget) -> Option<Part> {
    match (own, remote) {
        (Aim::Port(_), Aim::Port(port)) => Some(Part::Send(*port)),
        (Aim::Port(_), Aim::Windows(windows)) => {
            let swept = swept(windows, budget);
            (!swept.is_empty()).then(|| Part::Sweep(swept.to_vec()))
        }
        (Aim::Port(_), Aim::Set(set)) => Some(Part::Search { set: *set, count: search(*set, budget) }),
        // The peer sends to every port of this side's windows, so one mapping is enough.
        (Aim::Windows(_), Aim::Port(port)) => Some(Part::Open { sockets: 1, port: *port }),
        (Aim::Windows(own), Aim::Windows(theirs)) => {
            let (mine, yours) = (own[0], theirs[0]);
            if let ([_], [_]) = (&own[..], &theirs[..]) {
                // Two plain counters: one is measured and the other walks.
                let walker = walks((mine.count, mine.first, local.address), (yours.count, yours.first, peer))?;
                let (to, port) = (mine.past()?, yours.past()?);
                (mine.count < budget.mappings && yours.count < budget.mappings).then_some(match walker {
                    true => Part::Walk { to, step: mine.step },
                    false => Part::Measure { port },
                })
            } else {
                // Several cursors on a side: a socket cannot choose the cursor it lands on, so each
                // side opens enough for its most used cursor to reach its window's last port.
                let sockets = landings(local, mine.count)?;
                (sockets <= budget.mappings).then_some(Part::Open { sockets, port: yours.last() })
            }
        }
        // The peer searches this side's set, and the pool is what the budget allows of the size
        // that search calls for.
        (Aim::Set(set), Aim::Port(port)) => Some(Part::Open { sockets: pool(*set, search(*set, budget)).min(budget.mappings), port: *port }),
        // A set against windows or a set: see the bound in the module's head.
        (Aim::Windows(_) | Aim::Set(_), Aim::Set(_)) | (Aim::Set(_), Aim::Windows(_)) => None,
    }
}

/// The probability that the parts of two sides meet, under the allocators read. Both leads are
/// measured as in [`Model::aim`], both sides have the same budget, and no foreign allocation falls
/// inside a burst of mappings except where a walker races for its port. `None` is an abstention, as
/// in [`part`].
pub fn chance(local: &Model, local_lead_ms: u32, remote: &Model, remote_lead_ms: u32, budget: Budget) -> Option<f64> {
    let (local_aim, remote_aim) = (local.aim(local_lead_ms)?, remote.aim(remote_lead_ms)?);
    let local_part = part(local, &local_aim, &remote_aim, remote.address, budget)?;
    let remote_part = part(remote, &remote_aim, &local_aim, local.address, budget)?;
    // One side of the pair as the other's part meets it.
    let side = |model: &Model, lead_ms: u32, own: &Part, other: &Part| match (&model.allocator, own, other) {
        // The peer sweeps some of this side's windows: the mapping must land on a swept cursor
        // and that cursor's traffic must stay inside its window.
        (Allocator::Cursors(cursors), _, Part::Sweep(swept)) => {
            let total: f64 = cursors.iter().map(|cursor| f64::from(cursor.landings)).sum();
            let reached: f64 = windowed(cursors, lead_ms).take(swept.len()).map(|(cursor, _)| f64::from(cursor.landings) / total * cursor.covered(lead_ms)).sum();
            seen(cursors) * reached
        }
        // Measured: nothing may fall inside the measurement.
        (Allocator::Cursors(cursors), Part::Measure { .. }, _) => (-2.0 * cursors[0].per_second() * BURST_SPACING_US / 1e6).exp(),
        // Walker: its traffic must not have passed the port named, and its own socket must take
        // the port, which other traffic races it for.
        (Allocator::Cursors(cursors), Part::Walk { .. }, _) => {
            cursors[0].covered(lead_ms) / (1.0 + cursors[0].per_second() * BURST_SPACING_US / 1e6)
        }
        // Several cursors: enough of the sockets opened must land on the most used one.
        (Allocator::Cursors(cursors), Part::Open { sockets, .. }, Part::Open { .. }) => {
            let total: f64 = cursors.iter().map(|cursor| f64::from(cursor.landings)).sum();
            let needed = cursors[0].window(lead_ms).map_or(u16::MAX, |window| window.count);
            seen(cursors) * cursors[0].covered(lead_ms) * binomial_at_least(*sockets, f64::from(cursors[0].landings) / total, needed)
        }
        (Allocator::Set(set), Part::Open { sockets, .. }, Part::Search { count, .. }) => 1.0 - missed(*set, *count).powi(i32::from(*sockets)),
        _ => 1.0,
    };
    Some(side(local, local_lead_ms, &local_part, &remote_part) * side(remote, remote_lead_ms, &remote_part, &local_part))
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

/// How many ports of `set` one side's packets search.
fn search(set: PortSet, budget: Budget) -> u16 {
    u32::from(budget.packets).min(set.size()) as u16
}

/// The chance that one mapping drawn by the allocator escapes a search of `count` ports of `set`:
/// it lies outside the set, or on a port of it that was not searched.
fn missed(set: PortSet, count: u16) -> f64 {
    1.0 - set.holds() * f64::from(count) / f64::from(set.size())
}

/// The least pool that escapes a search of `count` ports of `set` no more often than
/// [`POOL_MISS`]: one mapping when the search covers a set that surely holds it.
fn pool(set: PortSet, count: u16) -> u16 {
    let missed = missed(set, count);
    if missed <= POOL_MISS {
        return 1;
    }
    (POOL_MISS.ln() / missed.ln()).ceil().min(f64::from(u16::MAX)) as u16
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
    let mut cursors: Vec<Cursor> = runs.iter().map(|run| cursor(run)).collect();
    // A port seen once may be a cursor of its own. It is kept with the step the believed ones
    // have and the traffic they showed together.
    let step = cursors.iter().find(|cursor| usize::from(cursor.landings) >= BELIEVED).map_or(1, |cursor| cursor.step);
    let (foreign, watched_ms) = cursors
        .iter()
        .filter(|cursor| usize::from(cursor.landings) >= BELIEVED)
        .fold((0u16, 0u32), |(foreign, watched), cursor| (foreign.saturating_add(cursor.foreign), watched + cursor.watched_ms));
    for lone in cursors.iter_mut().filter(|cursor| cursor.landings == 1) {
        (lone.step, lone.foreign, lone.watched_ms) = (step, foreign, watched_ms);
    }
    cursors.sort_by(|a, b| b.landings.cmp(&a.landings).then(b.at_ms.cmp(&a.at_ms)));
    Some(cursors)
}

/// The cursor a run of ports shows.
fn cursor(run: &[(u32, u16)]) -> Cursor {
    let (first_ms, _) = run[0];
    let (at_ms, last) = run[run.len() - 1];
    let differences: Vec<i32> = run.windows(2).map(|pair| i32::from(pair[1].1) - i32::from(pair[0].1)).collect();
    let divisor = differences.iter().fold(0, |divisor, difference| gcd(divisor, difference.unsigned_abs()));
    let step = differences.first().map_or(1, |first| first.signum() * if divisor <= MAX_STEP { divisor as i32 } else { 1 });
    let foreign: u32 = differences.iter().map(|difference| (difference / step - 1).unsigned_abs()).sum();
    Cursor {
        last,
        at_ms,
        step: step as i16,
        landings: run.len() as u16,
        foreign: foreign.min(u32::from(u16::MAX)) as u16,
        watched_ms: at_ms - first_ms,
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
    let found = cursor(allocations);
    let per_second = u64::from(found.foreign) * 1000 / u64::from(found.watched_ms.max(1));
    (divisor <= MAX_STEP && per_second <= MAX_FOREIGN_PER_SECOND).then_some(found)
}

/// The set the allocations were drawn from: a port set they all share, or the span they cover.
fn port_set(allocations: &[(u32, u16)]) -> PortSet {
    let ports = || allocations.iter().map(|&(_, port)| port);
    let seen = {
        let mut seen: Vec<u16> = ports().collect();
        seen.sort_unstable();
        seen.dedup();
        seen.len() as u16
    };
    for (offset, length) in PORT_SET_SHAPES {
        if u32::from(length) * u32::from(seen.saturating_sub(1)) < PORT_SET_EVIDENCE_BITS {
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
        seen,
    }
}

/// The foreign allocations to expect `lead_ms` after a cursor showed `foreign` of them in
/// `watched_ms`: the least range that leaves [`TAIL`] outside at each end, and the mass inside it.
/// The count is negative binomial, which is a Poisson count whose rate is known only through the
/// watch (Jeffreys' prior on the rate), so a short watch gives a wide range. `None` when the range
/// would pass [`WIDEST_WINDOW`].
fn predicted(foreign: u16, watched_ms: u32, lead_ms: u32) -> Option<(u32, u32, f64)> {
    if lead_ms == 0 {
        return Some((0, 0, 1.0));
    }
    let shape = f64::from(foreign) + 0.5;
    let watched = f64::from(watched_ms.max(1));
    let stay = watched / (watched + f64::from(lead_ms));
    let mut log_term = shape * stay.ln();
    let (mut below, mut total, mut low) = (0.0, 0.0, None);
    for count in 0..=WIDEST_WINDOW {
        let term = log_term.exp();
        if low.is_none() && total + term > TAIL {
            (low, below) = (Some(count), total);
        }
        total += term;
        if total >= 1.0 - TAIL {
            return Some((low?, count, total - below));
        }
        log_term += ((f64::from(count) + shape) / f64::from(count + 1)).ln() + (1.0 - stay).ln();
    }
    None
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
    /// The surveys of these tests ask every 400 ms, and their mappings are made 300 ms after the last.
    const EVERY_MS: u32 = 400;

    /// One sample for each port, from sockets and observers in turn.
    fn survey(sockets: u8, ports: &[u16]) -> Vec<Sample> {
        ports
            .iter()
            .enumerate()
            .map(|(index, port)| Sample {
                socket: index as u8 % sockets,
                local_port: 50_000 + index as u16 % u16::from(sockets),
                observer: SocketAddrV4::new(Ipv4Addr::new(198, 51, 100, 1 + (index / sockets as usize) as u8), 3478),
                sent_ms: index as u32 * EVERY_MS,
                mapped: SocketAddrV4::new(WAN, *port),
            })
            .collect()
    }
    fn model(sockets: u8, ports: &[u16]) -> Model {
        Model::read(&survey(sockets, ports)).unwrap()
    }
    fn lead(ports: usize) -> u32 {
        (ports as u32 - 1) * EVERY_MS + 300
    }
    fn counter(last: u16, at_ms: u32, step: i16, landings: u16, foreign: u16) -> Allocator {
        Allocator::Cursors(vec![Cursor { last, at_ms, step, landings, foreign, watched_ms: at_ms }])
    }
    fn windows(model: &Model, lead_ms: u32) -> Vec<Window> {
        match model.aim(lead_ms) {
            Some(Aim::Windows(windows)) => windows,
            other => panic!("no windows: {other:?}"),
        }
    }

    #[test]
    fn reads_a_point_a_counter_and_a_set() {
        assert_eq!(model(1, &[40_000, 40_000, 40_000]).allocator, Allocator::Point { port: 40_000, preserved: false });
        assert_eq!(model(1, &[50_000, 50_000, 50_000]).allocator, Allocator::Point { port: 50_000, preserved: true });
        assert_eq!(model(1, &[40_000, 40_002, 40_004]).allocator, counter(40_004, 800, 2, 3, 0));
        assert_eq!(model(1, &[40_000, 39_999, 39_998]).allocator, counter(39_998, 800, -1, 3, 0));
        // Other traffic took 2, 0, 3, 1 and 1 allocations between six of ours.
        assert_eq!(model(2, &[40_000, 40_003, 40_004, 40_008, 40_010, 40_012]).allocator, counter(40_012, 2_000, 1, 6, 7));
        assert_eq!(
            model(2, &[51_200, 60_011, 50_333, 64_100, 57_000, 52_048]).allocator,
            Allocator::Set(PortSet::Span { low: 50_333, high: 64_100, seen: 6 })
        );
    }

    #[test]
    fn a_busy_counter_needs_five_mappings_and_plausible_traffic() {
        // Gaps of 40 to 90 are too wide for a quiet cursor, and six that rise together are one
        // counter: 25 foreign allocations in two seconds.
        assert_eq!(model(2, &[40_000, 40_040, 40_100, 40_190, 40_230, 40_300]).allocator, counter(40_300, 2_000, 10, 6, 25));
        // Four are too few, and six that rise by thousands imply traffic no counter has.
        assert!(matches!(model(2, &[40_000, 40_040, 40_100, 40_190]).allocator, Allocator::Set(_)));
        assert!(matches!(
            model(2, &[1_500, 9_000, 20_000, 31_000, 44_000, 60_000]).allocator,
            Allocator::Set(_)
        ));
        // A fall of half the port space is no counter, and reading it does not overflow.
        assert!(matches!(model(1, &[40_000, 7_232]).allocator, Allocator::Set(_)));
    }

    #[test]
    fn reads_the_cursors_of_a_carrier_network() {
        // Ports a carrier network gave on 2026-11-26, in the order they were made.
        let ports = [14_156, 34_188, 6_253, 63_295, 34_189, 63_296, 6_254, 63_297, 34_190, 63_298, 63_299, 63_300, 34_191, 21_019];
        let allocations: Vec<(u32, u16)> = ports.iter().enumerate().map(|(index, port)| (index as u32 * EVERY_MS, *port)).collect();
        let Allocator::Cursors(cursors) = Allocator::of(&allocations) else { panic!("not cursors") };
        let seen: Vec<(u16, u16)> = cursors.iter().map(|cursor| (cursor.last, cursor.landings)).collect();
        assert_eq!(seen, [(63_300, 6), (34_191, 4), (6_254, 2), (21_019, 1), (14_156, 1)]);
        assert!(cursors.iter().all(|cursor| cursor.step == 1 && cursor.foreign == 0));
        // A peer with one mapping sweeps a window on each cursor. A cursor watched briefly or long
        // ago gets the wider window, and the five take 35 packets together.
        let network = Model { address: WAN, allocator: Allocator::Cursors(cursors) };
        let point = model(1, &[40_000, 40_000, 40_000]);
        let aim = network.aim(lead(ports.len())).unwrap();
        let Some(Part::Sweep(swept)) = part(&point, &Aim::Port(40_000), &aim, WAN, BUDGET) else { panic!("no sweep") };
        assert_eq!(swept.iter().map(|window| window.first).collect::<Vec<_>>(), [63_301, 34_192, 6_255, 21_020, 14_157]);
        assert_eq!(swept.iter().map(|window| u32::from(window.count)).sum::<u32>(), 35);
        // Two of the fourteen landings were on cursors seen once, so one landing in seven is taken
        // to fall on a cursor not seen at all.
        assert!((0.855..0.858).contains(&chance(&point, 40, &network, lead(ports.len()), BUDGET).unwrap()));
        // Two such networks: each opens enough sockets for its most used cursor to reach its window.
        let sockets = (u32::from(swept[0].count) * 14 * 2).div_ceil(6) as u16;
        assert_eq!(part(&network, &aim, &aim, PEER, BUDGET), Some(Part::Open { sockets, port: swept[0].last() }));
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
        // A search of the whole set needs one mapping.
        assert_eq!(pool(set, 240), 1);
    }

    #[test]
    fn a_span_holds_the_next_draw_as_often_as_its_samples_allow() {
        let span = |seen| PortSet::Span { low: 20_000, high: 20_999, seen };
        assert_eq!(span(3).holds(), 0.5);
        assert!((span(6).holds() - 5.0 / 7.0).abs() < 1e-12);
        // Searching all of a span three ports drew still misses every other mapping, so the pool
        // is seven; six ports make it four.
        assert_eq!(pool(span(3), 1_000), 7);
        assert_eq!(pool(span(6), 1_000), 4);
        assert_eq!(pool(span(6), 100), 63);
    }

    #[test]
    fn a_window_holds_the_traffic_predicted_and_widens_with_a_short_watch() {
        // Nothing foreign in a watch of six seconds: three hundred milliseconds later the count is
        // zero to two. The same after a watch of forty milliseconds could be anything up to dozens.
        assert_eq!(predicted(0, 6_000, 300).map(|(low, high, _)| (low, high)), Some((0, 2)));
        let (low, high, mass) = predicted(0, 40, 300).unwrap();
        assert!(low == 0 && (30..=80).contains(&high) && mass >= 0.999);
        // Fourteen in two seconds is seven a second: about two in 300 ms, and the range holds 99.9%.
        let (low, high, mass) = predicted(14, 2_000, 300).unwrap();
        assert!(low == 0 && (8..=11).contains(&high) && mass >= 0.999 && mass <= 1.0);
        // A known mean of two would need zero to eight for the same mass; the watch adds to it.
        assert!(predicted(1_000, 500_000, 1_000).unwrap().1 >= 8);
        // Nothing is predicted for no time, and heavy unknown traffic has no window.
        assert_eq!(predicted(40, 100, 0), Some((0, 0, 1.0)));
        assert_eq!(predicted(2_000, 1_000, 2_000), None);
    }

    #[test]
    fn a_counter_aims_past_the_traffic_expected_before_its_mappings() {
        let busy = model(2, &[40_000, 40_003, 40_004, 40_008, 40_010, 40_012]);
        let (low, high, _) = predicted(7, 2_000, 300).unwrap();
        assert_eq!(windows(&busy, lead(6)), [Window { first: 40_012 + 1 + low as u16, step: 1, count: (high - low + 1) as u16 }]);
        // A counter that would run past the last port has no aim.
        assert_eq!(model(1, &[65_520, 65_524, 65_528]).aim(lead(3)), None);
    }

    #[test]
    fn each_pair_has_its_part() {
        let point = model(1, &[40_000, 40_000, 40_000]);
        let quiet = model(1, &[50_000, 50_001, 50_002, 50_003, 50_004, 50_005]);
        let busy = model(2, &[40_000, 40_003, 40_004, 40_008, 40_010, 40_012]);
        let set = model(2, &[51_200, 60_011, 50_333, 64_100, 57_000, 52_048]);
        let aim = |model: &Model| model.aim(lead(6)).unwrap();
        let (quiet_window, busy_window) = (windows(&quiet, lead(6))[0], windows(&busy, lead(6))[0]);
        assert!(quiet_window.count < busy_window.count);
        assert_eq!(part(&point, &aim(&point), &aim(&point), PEER, BUDGET), Some(Part::Send(40_000)));
        // A point sends to every port of a counter's window and the counter opens one mapping.
        assert_eq!(part(&point, &aim(&point), &aim(&quiet), PEER, BUDGET), Some(Part::Sweep(vec![quiet_window])));
        assert_eq!(part(&quiet, &aim(&quiet), &aim(&point), PEER, BUDGET), Some(Part::Open { sockets: 1, port: 40_000 }));
        // Two counters: the busier walks onto the last port of its own window and the other
        // measures one mapping to it. Alike in window and port, the higher address walks.
        // The port named is one past the window, because the walker's reading takes one.
        assert_eq!(part(&busy, &aim(&busy), &aim(&quiet), PEER, BUDGET), Some(Part::Walk { to: busy_window.last() + 1, step: 1 }));
        assert_eq!(part(&quiet, &aim(&quiet), &aim(&busy), PEER, BUDGET), Some(Part::Measure { port: busy_window.last() + 1 }));
        assert_eq!(part(&quiet, &aim(&quiet), &aim(&quiet), PEER, BUDGET), Some(Part::Walk { to: quiet_window.last() + 1, step: 1 }));
        assert_eq!(part(&quiet, &aim(&quiet), &aim(&quiet), Ipv4Addr::new(203, 0, 113, 9), BUDGET), Some(Part::Measure { port: quiet_window.last() + 1 }));
        // A reading on the window's last port still leaves one socket to open.
        assert_eq!(walk(quiet_window.last(), 1, quiet_window.last() + 1), Some(1));
        assert_eq!(part(&quiet, &aim(&quiet), &aim(&quiet), WAN, BUDGET), None);
        // The measured port is the one between two observations a step apart on each side; the
        // walker opens as many sockets as steps remain.
        assert_eq!(measured(41_000, 41_002, 1), Some(41_001));
        assert_eq!(measured(41_000, 41_003, 1), None);
        assert_eq!(walk(50_002, 1, 50_006), Some(4));
        assert_eq!(walk(50_006, 1, 50_006), None);
        assert_eq!(walk(50_010, -2, 50_004), Some(3));
        // A point searches the span the survey saw, and the set's pool is what the budget allows.
        let span = PortSet::Span { low: 50_333, high: 64_100, seen: 6 };
        assert_eq!(part(&point, &aim(&point), &aim(&set), PEER, BUDGET), Some(Part::Search { set: span, count: 1024 }));
        assert_eq!(part(&set, &aim(&set), &aim(&point), PEER, BUDGET), Some(Part::Open { sockets: 85, port: 40_000 }));
        assert_eq!(part(&set, &aim(&set), &aim(&point), PEER, Budget { mappings: 32, packets: 1024 }), Some(Part::Open { sockets: 32, port: 40_000 }));
        // A set has no part against a counter or another set.
        assert_eq!(part(&set, &aim(&set), &aim(&quiet), PEER, BUDGET), None);
        assert_eq!(part(&quiet, &aim(&quiet), &aim(&set), PEER, BUDGET), None);
        assert_eq!(part(&set, &aim(&set), &aim(&set), PEER, BUDGET), None);
    }

    #[test]
    fn a_cursor_without_a_window_keeps_no_weight() {
        // Two quiet cursors, the heavier on the last port: only the lighter has a window, and the
        // sweep is scored with its three landings of eight.
        let cursor = |last, landings| Cursor { last, at_ms: 6_000, step: 1, landings, foreign: 0, watched_ms: 6_000 };
        let network = Model { address: WAN, allocator: Allocator::Cursors(vec![cursor(65_535, 5), cursor(40_002, 3)]) };
        let point = model(1, &[40_000, 40_000, 40_000]);
        assert_eq!(windows(&network, 6_001), [Window { first: 40_003, step: 1, count: 1 }]);
        let expected = 3.0 / 8.0 * (6_000.0f64 / 6_001.0).sqrt();
        assert!((chance(&point, 40, &network, 6_001, BUDGET).unwrap() - expected).abs() < 1e-9);
    }

    #[test]
    fn chances_follow_the_allocators() {
        let point = model(1, &[40_000, 40_000, 40_000]);
        let quiet = model(1, &[50_000, 50_001, 50_002, 50_003, 50_004, 50_005]);
        let busy = model(2, &[40_000, 40_003, 40_004, 40_008, 40_010, 40_012]);
        let wide = model(2, &[1_200, 60_011, 30_333, 64_100, 17_000, 52_048]);
        let block = model(2, &[20_500, 21_900, 20_480, 22_500, 21_000, 22_048]);
        let at = lead(6);
        assert_eq!(chance(&point, 40, &point, 40, BUDGET), Some(1.0));
        assert!(chance(&point, 40, &busy, at, BUDGET).unwrap() > 0.998);
        // Three and a half foreign allocations a second cost the walker's race under a tenth of a per cent.
        assert!((0.997..1.0).contains(&chance(&quiet, at, &busy, at, BUDGET).unwrap()));
        // Two counters alike in everything, and a set against a counter, have no plan: an abstention.
        assert_eq!(chance(&busy, at, &busy, at, BUDGET), None);
        assert_eq!(chance(&wide, at, &busy, at, BUDGET), None);
        // A span six ports drew holds five mappings of seven. In 62,901 ports a pool of 256 meets a
        // search of 1,024 about nineteen times in twenty; a block of 2,021 ports is met with eleven.
        assert!((0.94..0.96).contains(&chance(&point, 40, &wide, at, BUDGET).unwrap()));
        assert_eq!(part(&block, &block.aim(at).unwrap(), &Aim::Port(40_000), PEER, BUDGET), Some(Part::Open { sockets: 11, port: 40_000 }));
        assert!(chance(&point, 40, &block, at, BUDGET).unwrap() > 0.99);
        assert!((binomial_at_least(14, 6.0 / 14.0, 4) - 0.914).abs() < 0.005);
        assert!(binomial_at_least(19, 6.0 / 14.0, 4) > 0.98);
    }
}
