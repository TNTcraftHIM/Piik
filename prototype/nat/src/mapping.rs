//! What a survey tells about a NAT's port allocator, and where its next mappings will be.
//!
//! A survey is a table of samples: which socket asked which observer when, and the address the
//! observer saw. This module reads one of three allocators from it: a point (one mapping whatever
//! the destination), cursors (a new mapping lands one step past one of a few counters, which other
//! traffic advances too), or draws. For cursors [`Model::aim`] gives the ports a peer should send
//! to, and [`replay`] says how often such aims would have held the survey's own mappings.
use std::net::{Ipv4Addr, SocketAddrV4};

/// The lowest port a mapping is expected on; lower ports are not aimed at.
pub const LOWEST_PORT: u16 = 1024;
/// A cursor's step is at most this.
const MAX_STEP: u32 = 16;
/// A port joins a run when it lies at most this far past one of the run's ends.
const MAX_GAP: i32 = 32;
/// A run of this many ports is taken at its word for its step and its traffic; a port seen once
/// borrows both from such runs.
const BELIEVED: usize = 3;
/// The fewest ports a NAT that draws is taken to draw from: the smallest block a carrier hands
/// one subscriber. Without it three ports in a row would pass for draws from a set of three.
const SMALLEST_SET: f64 = 64.0;
/// How often a mapping begins a cursor not seen before, as far as anything is known beforehand.
const NEW_CURSOR: f64 = 0.5;
/// How often a follower turns up among a run's ports and not past one of its ends: mappings made
/// close together reach the NAT in any order.
const LATE: f64 = 0.1;
/// A cursor's ports leave this much of its predicted traffic outside at each end.
const TAIL: f64 = 0.0005;
/// A cursor whose traffic could carry it over more ports than this has no ports to aim at.
const WIDEST_WINDOW: u32 = 512;

/// One answer of a survey.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sample {
    pub socket: u16,
    /// The port the socket is bound to on this machine.
    pub local_port: u16,
    pub observer: SocketAddrV4,
    /// Milliseconds since the survey began.
    pub sent_ms: u32,
    pub mapped: SocketAddrV4,
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
    /// Ports it passed that the survey did not get, over `watched_ms`: other traffic.
    pub foreign: u16,
    pub watched_ms: u32,
}
impl Cursor {
    /// The port `steps` allocations past the last one seen, when it is a port that is aimed at.
    fn port(&self, steps: u32) -> Option<u16> {
        u16::try_from(i64::from(self.last) + i64::from(self.step) * i64::from(steps)).ok().filter(|port| *port >= LOWEST_PORT)
    }
    /// The traffic the survey saw, in mappings a second.
    pub fn per_second(&self) -> f64 {
        f64::from(self.foreign) * 1000.0 / f64::from(self.watched_ms.max(1))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Allocator {
    /// One mapping whatever the destination, on the socket's own port when `preserved`.
    Point { port: u16, preserved: bool },
    /// Each new mapping lands one step past one of these, the most used first.
    Cursors(Vec<Cursor>),
    /// Each new mapping is a draw; these are the lowest and highest ports seen.
    Drawn { low: u16, high: u16 },
}
impl Allocator {
    /// The allocator behind new mappings, each given as its time in milliseconds and its port, in
    /// the order they were made.
    pub fn of(allocations: &[(u32, u16)]) -> Self {
        let ports = || allocations.iter().map(|&(_, port)| port);
        cursors(allocations).map_or_else(|| Self::Drawn { low: ports().min().unwrap_or(LOWEST_PORT), high: ports().max().unwrap_or(u16::MAX) }, Self::Cursors)
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
        let compared = samples.iter().any(|sample| samples.iter().any(|other| other.socket == sample.socket && other.observer != sample.observer));
        if !compared {
            return Err(Unusable::TooFew);
        }
        let mut ordered = samples.to_vec();
        ordered.sort_by_key(|sample| sample.sent_ms);
        // A socket that shows one port to every observer has one mapping. The model speaks for
        // the earliest socket; the caller keeps that socket.
        let independent = ordered.iter().all(|sample| ordered.iter().all(|other| other.socket != sample.socket || other.mapped == sample.mapped));
        if independent {
            let preserved = ordered.iter().all(|sample| sample.mapped.port() == sample.local_port);
            return Ok(Self { address, allocator: Allocator::Point { port: ordered[0].mapped.port(), preserved } });
        }
        // What remains is one new mapping for each port not seen before on its socket.
        let mut allocations: Vec<(u32, u16)> = Vec::with_capacity(ordered.len());
        for (index, sample) in ordered.iter().enumerate() {
            if !ordered[..index].iter().any(|earlier| earlier.socket == sample.socket && earlier.mapped == sample.mapped) {
                allocations.push((sample.sent_ms, sample.mapped.port()));
            }
        }
        Ok(Self { address, allocator: Allocator::of(&allocations) })
    }

    /// The ports a peer allowed `packets` should send to for a mapping made `lead_ms` after the
    /// survey began, one window for each cursor that gets any. Empty when the allocator has no
    /// cursors or none of them can be aimed at.
    ///
    /// A port's worth is its cursor's share of landings times the chance that other traffic
    /// carries the cursor exactly there, and the worthiest are taken first. So a cursor whose
    /// traffic could carry it further than the packets reach still gets the ports around its
    /// likeliest one.
    pub fn aim(&self, lead_ms: u32, packets: u16) -> Vec<Window> {
        let Allocator::Cursors(cursors) = &self.allocator else { return Vec::new() };
        let total: f64 = cursors.iter().map(|cursor| f64::from(cursor.landings)).sum();
        /// One cursor that can be aimed at: its share of landings, the least count of foreign
        /// allocations, the chance of each count from there, and the counts taken so far.
        struct Reach {
            share: f64,
            low: u32,
            terms: Vec<f64>,
            taken: Option<(usize, usize)>,
        }
        let mut reaches: Vec<Option<Reach>> = cursors
            .iter()
            .map(|cursor| {
                let (low, terms) = spread(cursor.foreign, cursor.watched_ms, lead_ms.saturating_sub(cursor.at_ms))?;
                cursor.port(low + 1)?;
                cursor.port(low + terms.len() as u32)?;
                Some(Reach { share: f64::from(cursor.landings) / total, low, terms, taken: None })
            })
            .collect();
        for _ in 0..packets {
            // The worthiest port not yet taken is the likeliest count of a cursor, or a neighbour
            // of the counts already taken on it: the chances fall away on both sides.
            let best = reaches
                .iter()
                .enumerate()
                .filter_map(|(index, reach)| {
                    let reach = reach.as_ref()?;
                    let candidates = match reach.taken {
                        None => [reach.terms.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).map(|(at, _)| at), None],
                        Some((first, last)) => [first.checked_sub(1), (last + 1 < reach.terms.len()).then_some(last + 1)],
                    };
                    candidates.into_iter().flatten().map(|at| (reach.share * reach.terms[at], index, at)).max_by(|a, b| a.0.total_cmp(&b.0))
                })
                .max_by(|a, b| a.0.total_cmp(&b.0));
            let Some((_, index, at)) = best else { break };
            let taken = &mut reaches[index].as_mut().unwrap().taken;
            *taken = Some(taken.map_or((at, at), |(first, last)| (first.min(at), last.max(at))));
        }
        cursors
            .iter()
            .zip(reaches)
            .filter_map(|(cursor, reach)| {
                let reach = reach?;
                let (first, last) = reach.taken?;
                Some(Window { first: cursor.port(reach.low + first as u32 + 1)?, step: cursor.step, count: (last - first + 1) as u16 })
            })
            .collect()
    }
}

/// `count` ports from `first` in steps of `step`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Window {
    pub first: u16,
    pub step: i16,
    pub count: u16,
}
impl Window {
    pub fn holds(&self, port: u16) -> bool {
        let distance = i32::from(port) - i32::from(self.first);
        let step = i32::from(self.step);
        distance % step == 0 && (0..i32::from(self.count)).contains(&(distance / step))
    }
}

/// Which of the mappings made before a target a replayed aim may read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Holdout {
    /// All of them.
    Nothing,
    /// Those toward other destinations, an address and a port being one destination.
    Destination,
    /// Those toward other addresses, which is what is known about a peer never sent to.
    Address,
}

/// How a survey's own mappings fare against the aims read from the mappings before them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Replay {
    /// The aim held the mapping's port.
    pub held: u16,
    pub missed: u16,
    /// The mappings before it gave no ports to aim at.
    pub no_aim: u16,
    /// Fewer mappings came before it than a reading is asked to have.
    pub too_early: u16,
}

/// Replays a survey: for each new mapping, would the aim read from the mappings before it, for a
/// peer allowed `packets`, have held its port? `made` are the new mappings in the order made, each
/// made after the answer to the one before it was read.
pub fn replay(made: &[Sample], least: usize, holdout: Holdout, packets: u16) -> Replay {
    let mut replay = Replay::default();
    for (index, target) in made.iter().enumerate() {
        let known: Vec<(u32, u16)> = made[..index]
            .iter()
            .filter(|earlier| match holdout {
                Holdout::Nothing => true,
                Holdout::Destination => earlier.observer != target.observer,
                Holdout::Address => earlier.observer.ip() != target.observer.ip(),
            })
            .map(|earlier| (earlier.sent_ms, earlier.mapped.port()))
            .collect();
        let aim = Model { address: *target.mapped.ip(), allocator: Allocator::of(&known) }.aim(target.sent_ms, packets);
        let outcome = match () {
            () if known.len() < least => &mut replay.too_early,
            () if aim.is_empty() => &mut replay.no_aim,
            () if aim.iter().any(|window| window.holds(target.mapped.port())) => &mut replay.held,
            () => &mut replay.missed,
        };
        *outcome += 1;
    }
    replay
}

/// The cursors behind allocations in the order they were made, the most used first, or `None`
/// when the ports are likelier draws.
fn cursors(allocations: &[(u32, u16)]) -> Option<Vec<Cursor>> {
    let (runs, odds) = runs(allocations);
    if odds <= 0.0 {
        return None;
    }
    let mut cursors: Vec<Cursor> = runs.iter().map(|run| cursor(run)).collect();
    // A port seen once may be a cursor of its own. It is kept with the step the believed ones
    // have and the traffic they showed together.
    let believed = |cursor: &&Cursor| usize::from(cursor.landings) >= BELIEVED;
    let step = cursors.iter().find(believed).map_or(1, |cursor| cursor.step);
    let (foreign, watched_ms) = cursors.iter().filter(believed).fold((0u16, 0u32), |(foreign, watched), cursor| (foreign.saturating_add(cursor.foreign), watched + cursor.watched_ms));
    for lone in cursors.iter_mut().filter(|cursor| cursor.landings == 1) {
        (lone.step, lone.foreign, lone.watched_ms) = (step, foreign, watched_ms);
    }
    cursors.sort_by(|a, b| b.landings.cmp(&a.landings).then(b.at_ms.cmp(&a.at_ms)));
    Some(cursors)
}

/// The runs of ports that follow one another, and the logarithm of how many times likelier the
/// ports are as followers of cursors than as draws.
///
/// As a follower a port belongs to one of the runs so far, each as likely as another. Most often
/// it lies past one of the run's two ends, `g` ports out with a chance that falls as `1/g` up to
/// [`MAX_GAP`], which favours no step and no direction; now and then ([`LATE`]) it is a port
/// between the ends that no mapping holds yet. As the first of a cursor it may be any port. A
/// port joins the run that gives it the larger chance. As a draw, a port is one of those left in
/// a set as large as the span the ports cover, and no smaller than [`SMALLEST_SET`].
fn runs(allocations: &[(u32, u16)]) -> (Vec<Vec<(u32, u16)>>, f64) {
    let ports = || allocations.iter().map(|&(_, port)| f64::from(port));
    let set = (ports().fold(f64::MIN, f64::max) - ports().fold(f64::MAX, f64::min) + 1.0).max(SMALLEST_SET);
    let every = f64::from(u16::MAX - LOWEST_PORT) + 1.0;
    let gaps: f64 = (1..=MAX_GAP).map(|gap| 1.0 / f64::from(gap)).sum();
    let mut runs: Vec<Vec<(u32, u16)>> = Vec::new();
    let mut odds = 0.0;
    for (index, &(at_ms, port)) in allocations.iter().enumerate() {
        // The chance of this port as a follower of each run, and the run that gives the most.
        let follows = runs
            .iter()
            .enumerate()
            .filter_map(|(run_index, run)| {
                let members = || run.iter().map(|&(_, member)| i32::from(member));
                let (low, high, port) = (members().min()?, members().max()?, i32::from(port));
                let beyond = (low - port).max(port - high);
                let chance = match beyond {
                    1..=MAX_GAP => (1.0 - LATE) / 2.0 / (f64::from(beyond) * gaps),
                    // A port a mapping already holds cannot be given again.
                    _ if beyond < 0 && members().all(|member| member != port) => LATE / f64::from(high - low + 1),
                    _ => return None,
                };
                Some((chance, run_index))
            })
            .max_by(|a, b| a.0.total_cmp(&b.0));
        let drawn = 1.0 / (set - index as f64).max(1.0);
        match follows {
            Some((chance, run_index)) => {
                odds += ((1.0 - NEW_CURSOR) / runs.len() as f64 * chance / drawn).ln();
                runs[run_index].push((at_ms, port));
            }
            None => {
                if !runs.is_empty() {
                    odds += (NEW_CURSOR / every / drawn).ln();
                }
                // A port seen twice stays with the run that has it; any other begins one.
                match runs.iter().position(|run| run.iter().any(|&(_, member)| member == port)) {
                    Some(held) => runs[held].push((at_ms, port)),
                    None => runs.push(vec![(at_ms, port)]),
                }
            }
        }
    }
    (runs, odds)
}

/// The cursor a run of ports shows. It moves the way its ports did between the earliest and the
/// latest of them, upward when they do not say, and it stands on the port furthest that way.
fn cursor(run: &[(u32, u16)]) -> Cursor {
    let times = || run.iter().map(|&(at_ms, _)| at_ms);
    let (first_ms, at_ms) = (times().min().unwrap_or(0), times().max().unwrap_or(0));
    let earliest = run.iter().filter(|(at, _)| *at == first_ms).map(|&(_, port)| port).min().unwrap_or(0);
    let latest = run.iter().filter(|(at, _)| *at == at_ms).map(|&(_, port)| port).max().unwrap_or(0);
    let mut ports: Vec<u16> = run.iter().map(|&(_, port)| port).collect();
    ports.sort_unstable();
    ports.dedup();
    let divisor = ports.windows(2).fold(0, |divisor, pair| gcd(divisor, u32::from(pair[1] - pair[0])));
    let step = if (1..=MAX_STEP).contains(&divisor) { divisor as i32 } else { 1 };
    let (low, high) = (ports[0], ports[ports.len() - 1]);
    let foreign = u32::from(high - low) / step as u32 + 1 - ports.len() as u32;
    let downward = latest < earliest;
    Cursor {
        last: if downward { low } else { high },
        at_ms,
        step: if downward { -step } else { step } as i16,
        landings: run.len() as u16,
        foreign: foreign.min(u32::from(u16::MAX)) as u16,
        watched_ms: at_ms - first_ms,
    }
}

/// The chance of each count of foreign allocations `lead_ms` after a cursor showed `foreign` of
/// them in `watched_ms`: the least count worth considering, and the chances from there up to the
/// greatest, leaving [`TAIL`] outside at each end. The count is negative binomial, which is a
/// Poisson count whose rate is known only through the watch (Jeffreys' prior on the rate), so a
/// short watch gives a wide range. `None` when the range would pass [`WIDEST_WINDOW`].
fn spread(foreign: u16, watched_ms: u32, lead_ms: u32) -> Option<(u32, Vec<f64>)> {
    if lead_ms == 0 {
        return Some((0, vec![1.0]));
    }
    let shape = f64::from(foreign) + 0.5;
    let watched = f64::from(watched_ms.max(1));
    let stay = watched / (watched + f64::from(lead_ms));
    let mut log_term = shape * stay.ln();
    let (mut total, mut low, mut terms) = (0.0, None, Vec::new());
    for count in 0..=WIDEST_WINDOW {
        let term = log_term.exp();
        if low.is_none() && total + term > TAIL {
            low = Some(count);
        }
        if low.is_some() {
            terms.push(term);
        }
        total += term;
        if total >= 1.0 - TAIL {
            return Some((low?, terms));
        }
        log_term += ((f64::from(count) + shape) / f64::from(count + 1)).ln() + (1.0 - stay).ln();
    }
    None
}

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 { a } else { gcd(b, a % b) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WAN: Ipv4Addr = Ipv4Addr::new(203, 0, 113, 7);
    /// The surveys of these tests ask every 400 ms, and their mappings are made 300 ms after the last.
    const EVERY_MS: u32 = 400;

    fn timed(ports: &[u16]) -> Vec<(u32, u16)> {
        ports.iter().enumerate().map(|(index, port)| (index as u32 * EVERY_MS, *port)).collect()
    }
    /// One sample for each port, from sockets and observers in turn.
    fn survey(sockets: u8, ports: &[u16]) -> Vec<Sample> {
        ports
            .iter()
            .enumerate()
            .map(|(index, port)| Sample {
                socket: u16::from(index as u8 % sockets),
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
    /// The least and greatest count of foreign allocations worth considering.
    fn range(foreign: u16, watched_ms: u32, lead_ms: u32) -> Option<(u32, u32)> {
        spread(foreign, watched_ms, lead_ms).map(|(low, terms)| (low, low + terms.len() as u32 - 1))
    }

    #[test]
    fn reads_a_point_a_counter_and_draws() {
        assert_eq!(model(1, &[40_000, 40_000, 40_000]).allocator, Allocator::Point { port: 40_000, preserved: false });
        assert_eq!(model(1, &[50_000, 50_000, 50_000]).allocator, Allocator::Point { port: 50_000, preserved: true });
        assert_eq!(model(1, &[40_000, 40_002, 40_004]).allocator, counter(40_004, 800, 2, 3, 0));
        assert_eq!(model(1, &[40_000, 39_999, 39_998]).allocator, counter(39_998, 800, -1, 3, 0));
        // Other traffic took 2, 0, 3, 1 and 1 allocations between six of ours.
        assert_eq!(model(2, &[40_000, 40_003, 40_004, 40_008, 40_010, 40_012]).allocator, counter(40_012, 2_000, 1, 6, 7));
        assert_eq!(model(2, &[51_200, 60_011, 50_333, 64_100, 57_000, 52_048]).allocator, Allocator::Drawn { low: 50_333, high: 64_100 });
        // One observer says nothing about dependence, and two addresses are not one NAT.
        let mut one = survey(1, &[40_000, 40_001]);
        one[1].observer = one[0].observer;
        assert_eq!(Model::read(&one), Err(Unusable::TooFew));
        let mut two = survey(1, &[40_000, 40_001]);
        two[1].mapped = SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 8), 40_001);
        assert_eq!(Model::read(&two), Err(Unusable::AddressesDiffer));
    }

    #[test]
    fn reads_several_cursors_and_keeps_draws_apart() {
        // A survey from the field: one cursor read four times, two read twice and three ports alone.
        let field = timed(&[14_194, 35_377, 8_225, 14_195, 35_379, 8_226, 14_197, 55_758, 14_198, 30_277, 14_418]);
        let Allocator::Cursors(cursors) = Allocator::of(&field) else { panic!("not cursors") };
        assert_eq!(cursors.iter().map(|cursor| (cursor.last, cursor.landings)).collect::<Vec<_>>(), [(14_198, 4), (8_226, 2), (35_379, 2), (14_418, 1), (30_277, 1), (55_758, 1)]);
        // Mappings that reached the NAT in another order than they were made are the same cursor.
        assert_eq!(Allocator::of(&[(0, 30_001), (0, 30_000), (500, 30_003), (500, 30_002)]), Allocator::Cursors(vec![Cursor { last: 30_003, at_ms: 500, step: 1, landings: 4, foreign: 0, watched_ms: 500 }]));
        // Eighteen draws from the whole range with two that fell close together are still draws.
        let wide = timed(&[51_200, 60_011, 50_333, 64_100, 57_000, 52_048, 9_100, 23_456, 31_000, 44_777, 12_345, 38_080, 60_020, 27_001, 5_150, 47_900, 19_090, 35_555]);
        assert_eq!(Allocator::of(&wide), Allocator::Drawn { low: 5_150, high: 64_100 });
        // So is a crowd inside a carrier's block of a thousand ports, where many come close by chance.
        let block = timed(&[20_512, 20_101, 20_877, 20_530, 20_120, 20_333, 20_890, 20_050, 20_700, 20_345, 20_990, 20_560, 20_222, 20_130, 20_640, 20_015, 20_800, 20_410]);
        assert!(matches!(Allocator::of(&block), Allocator::Drawn { .. }));
    }

    #[test]
    fn draws_seldom_pass_for_cursors() {
        // Draws from `set` ports in a row, with or without giving a port twice, from a seed.
        let draws = |seed: u64, set: u64, count: usize, again: bool| {
            let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
            let mut ports: Vec<u16> = Vec::new();
            while ports.len() < count {
                state ^= state >> 12;
                state ^= state << 25;
                state ^= state >> 27;
                let port = (20_000 + (state.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 33) % set) as u16;
                if again || !ports.contains(&port) {
                    ports.push(port);
                }
            }
            timed(&ports)
        };
        for (set, count, again) in [(64, 18, true), (64, 32, true), (64, 18, false), (1_000, 18, false), (64_000, 18, false), (64_000, 40, false)] {
            let surveys = 4_000;
            let read = (0..surveys).filter(|seed| matches!(Allocator::of(&draws(*seed, set, count, again)), Allocator::Cursors(_))).count();
            assert!(read * 20 <= surveys as usize, "{read} of {surveys} surveys of {count} draws from {set} were read as cursors");
        }
    }

    #[test]
    fn an_aim_follows_the_traffic_and_fits_the_packets() {
        // Nothing foreign in six seconds: 300 ms on, the next port or one of the two after it.
        assert_eq!(range(0, 6_000, 300), Some((0, 2)));
        // Fourteen in two seconds is seven a second: about two in 300 ms.
        let (low, high) = range(14, 2_000, 300).unwrap();
        assert!(low == 0 && (8..=11).contains(&high));
        // Nothing is predicted for no time, and heavy unknown traffic has no range.
        assert_eq!(range(40, 100, 0), Some((0, 0)));
        assert_eq!(range(2_000, 1_000, 2_000), None);

        let busy = model(2, &[40_000, 40_003, 40_004, 40_008, 40_010, 40_012]);
        let (low, high) = range(7, 2_000, 300).unwrap();
        assert_eq!(busy.aim(lead(6), 1_024), [Window { first: 40_012 + 1 + low as u16, step: 1, count: (high - low + 1) as u16 }]);
        // A counter that would run past the last port, and draws, give nothing to aim at.
        assert!(model(1, &[65_533, 65_534, 65_535]).aim(lead(3), 1_024).is_empty());
        assert!(model(2, &[51_200, 60_011, 50_333, 64_100, 57_000, 52_048]).aim(lead(6), 1_024).is_empty());

        // Sixty foreign allocations in a tenth of a second: a tenth of a second on, the cursor may
        // stand anywhere over more ports than 64 packets reach. The peer gets the 64 around the
        // likeliest, sixty past the cursor.
        let heavy = |last, landings| Cursor { last, at_ms: 1_000, step: 1, landings, foreign: 60, watched_ms: 100 };
        let (low, high) = range(60, 100, 100).unwrap();
        assert!(high - low + 1 > 64);
        let windows = Model { address: WAN, allocator: Allocator::Cursors(vec![heavy(40_000, 5)]) }.aim(1_100, 64);
        assert_eq!((windows.len(), windows[0].count), (1, 64));
        assert!(windows[0].holds(40_060) && !windows[0].holds(40_001));
        // Two cursors share the packets by what each port is worth: the one used more gets more.
        let shared = Model { address: WAN, allocator: Allocator::Cursors(vec![heavy(40_000, 9), heavy(50_000, 3)]) }.aim(1_100, 64);
        assert_eq!(shared.iter().map(|window| window.count).sum::<u16>(), 64);
        assert!(shared[0].count > shared[1].count && shared[1].count > 0);
        // A window counts its ports in its own direction.
        let down = Window { first: 39_997, step: -1, count: 3 };
        assert!(down.holds(39_997) && down.holds(39_995) && !down.holds(39_994) && !down.holds(39_998));
    }

    #[test]
    fn a_replay_judges_each_mapping_by_what_came_before_it() {
        let observer = |index: u8| SocketAddrV4::new(Ipv4Addr::new(198, 51, 100, 1 + index / 2), 3478 + u16::from(index % 2));
        let sample = |index: u32, port: u16| Sample { socket: index as u16, local_port: 50_000, observer: observer(index as u8 % 4), sent_ms: index * 100, mapped: SocketAddrV4::new(WAN, port) };
        // One counter read eight times toward four destinations on two addresses, then a ninth.
        let mut made: Vec<Sample> = (0..9).map(|index| sample(index, 40_000 + index as u16)).collect();
        // The first eight have too little before them, which is not a miss; the ninth is held.
        assert_eq!(replay(&made, 8, Holdout::Nothing, 1_024), Replay { held: 1, too_early: 8, ..Replay::default() });
        // Asked for four before it, more are judged, whichever the aim may read: other
        // destinations, or other addresses, which leaves fewer.
        assert_eq!(replay(&made, 4, Holdout::Destination, 1_024), Replay { held: 4, too_early: 5, ..Replay::default() });
        assert_eq!(replay(&made, 4, Holdout::Address, 1_024), Replay { held: 3, too_early: 6, ..Replay::default() });
        // A tenth on a counter nothing showed is missed, and one after draws has nothing to be held by.
        made.push(sample(9, 45_000));
        assert_eq!(replay(&made, 8, Holdout::Nothing, 1_024), Replay { held: 1, missed: 1, too_early: 8, ..Replay::default() });
        let drawn: Vec<Sample> = [51_200, 60_011, 50_333, 64_100, 57_000].iter().enumerate().map(|(index, port)| sample(index as u32, *port)).collect();
        assert_eq!(replay(&drawn, 4, Holdout::Nothing, 1_024), Replay { no_aim: 1, too_early: 4, ..Replay::default() });
    }
}
