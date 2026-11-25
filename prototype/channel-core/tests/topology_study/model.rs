//! Seeded inputs of the study: a small generator, the connectivity model and
//! the session script. Every value here is an assumption, not a measurement.

/// SplitMix64. Small, seedable and dependency-free; quality is ample for
/// drawing a few hundred decisions per session.
#[derive(Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed ^ 0x9E37_79B9_7F4A_7C15)
    }
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in [0, 1).
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
    pub fn range(&mut self, low: u64, high: u64) -> u64 {
        low + self.next_u64() % (high - low + 1)
    }
    pub fn chance(&mut self, p: f64) -> bool {
        self.unit() < p
    }
}

/// A participant's network, reduced to three behaviours that decide whether
/// ordinary ICE between two of them succeeds.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NatClass {
    /// Public address or endpoint-independent mapping and filtering.
    Open,
    /// Endpoint-independent mapping, address- or port-dependent filtering.
    Cone,
    /// Endpoint-dependent (symmetric) mapping.
    Hard,
}

/// One connectivity setting. ASSUMPTIONS, NOT MEASUREMENTS. The repository has
/// no field distribution of NAT classes. `docs/research/nat-traversal.md`
/// cites Iroh and Tailscale for "roughly nine-in-ten" and "above 90%" direct
/// reachability and the 2026 DCUtR paper for about 70% hole-punch success.
/// The three settings below are chosen so that the expected share of
/// connectable pairs brackets those figures: about 68%, 83% and 92%.
#[derive(Clone, Copy, Debug)]
pub struct Connectivity {
    pub name: &'static str,
    /// Shares of Open and Cone participants; the rest are Hard.
    pub open_share: f64,
    pub cone_share: f64,
    /// Hard with Hard never connects (no port prediction in this model).
    /// Hard with Cone connects with this probability (prediction sometimes works).
    pub hard_cone_success: f64,
    /// Every other combination connects with this probability (residual
    /// failures such as blocked UDP or a firewall).
    pub other_success: f64,
}

pub const PESSIMISTIC: Connectivity = Connectivity {
    name: "pessimistic",
    open_share: 0.20,
    cone_share: 0.50,
    hard_cone_success: 0.35,
    other_success: 0.95,
};
pub const BASE: Connectivity = Connectivity {
    name: "base",
    open_share: 0.25,
    cone_share: 0.55,
    hard_cone_success: 0.50,
    other_success: 0.97,
};
pub const OPTIMISTIC: Connectivity = Connectivity {
    name: "optimistic",
    open_share: 0.33,
    cone_share: 0.55,
    hard_cone_success: 0.60,
    other_success: 0.99,
};

impl Connectivity {
    pub fn class(&self, rng: &mut Rng) -> NatClass {
        let draw = rng.unit();
        if draw < self.open_share {
            NatClass::Open
        } else if draw < self.open_share + self.cone_share {
            NatClass::Cone
        } else {
            NatClass::Hard
        }
    }
    pub fn pair(&self, a: NatClass, b: NatClass, rng: &mut Rng) -> bool {
        use NatClass::*;
        let p = match (a, b) {
            (Hard, Hard) => 0.0,
            (Hard, Cone) | (Cone, Hard) => self.hard_cone_success,
            _ => self.other_success,
        };
        rng.chance(p)
    }
    /// Expected share of connectable pairs under independent class draws.
    pub fn expected_pair_success(&self) -> f64 {
        let (o, c) = (self.open_share, self.cone_share);
        let h = 1.0 - o - c;
        2.0 * h * c * self.hard_cone_success + (1.0 - h * h - 2.0 * h * c) * self.other_success
    }
}

/// Session timing. ASSUMPTIONS. Times are milliseconds of the core's clock.
pub const START_MS: u64 = 1_000;
/// Gap between successive viewer arrivals.
pub const ARRIVAL_GAP_MS: (u64, u64) = (12_000, 30_000);
/// Each viewer independently leaves with this probability...
pub const LEAVE_PROBABILITY: f64 = 0.25;
/// ...this long after arriving.
pub const STAY_MS: (u64, u64) = (40_000, 240_000);
/// In addition, one viewer per this many viewers (at least one) leaves at a
/// scripted time chosen among the viewers relaying for others at that time.
pub const VIEWERS_PER_RELAY_DEPARTURE: usize = 8;
/// After an event the harness lets the core's timers run this long, in steps,
/// before it observes the tree. Larger than the core's 5 s retry timers.
pub const QUIET_STEPS_MS: [u64; 2] = [5_500, 11_000];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    /// The viewer enters the room and subscribes to the screen.
    Arrive(usize),
    /// This viewer leaves the channel.
    Leave(usize),
    /// A viewer that currently forwards to someone leaves (chosen at run time
    /// from the live tree by the stated draw).
    RelayLeaves(u64),
}

#[derive(Clone, Debug)]
pub struct Event {
    pub at: u64,
    pub action: Action,
}

/// Everything drawn from the seed. Participant `i` is the `i`-th session in
/// session-identifier order, so the planner's identifier tie-breaks follow
/// this numbering and a seed reproduces the same run.
#[derive(Clone)]
pub struct Script {
    pub seed: u64,
    pub people: usize,
    pub source: usize,
    pub classes: Vec<NatClass>,
    pub connectable: Vec<Vec<bool>>,
    pub events: Vec<Event>,
}

impl Script {
    pub fn draw(seed: u64, viewers: usize, model: &Connectivity) -> Self {
        let people = viewers + 1;
        let mut rng = Rng::new(seed);
        let classes: Vec<_> = (0..people).map(|_| model.class(&mut rng)).collect();
        let mut connectable = vec![vec![false; people]; people];
        for a in 0..people {
            for b in a + 1..people {
                let ok = model.pair(classes[a], classes[b], &mut rng);
                connectable[a][b] = ok;
                connectable[b][a] = ok;
            }
        }
        let source = rng.below(people);
        let mut order: Vec<_> = (0..people).filter(|&p| p != source).collect();
        for i in (1..order.len()).rev() {
            let j = rng.below(i + 1);
            order.swap(i, j);
        }
        let mut events = Vec::new();
        let mut at = START_MS;
        for &viewer in &order {
            at += rng.range(ARRIVAL_GAP_MS.0, ARRIVAL_GAP_MS.1);
            events.push(Event {
                at,
                action: Action::Arrive(viewer),
            });
            if rng.chance(LEAVE_PROBABILITY) {
                events.push(Event {
                    at: at + rng.range(STAY_MS.0, STAY_MS.1),
                    action: Action::Leave(viewer),
                });
            }
        }
        let last_arrival = at;
        for _ in 0..(viewers / VIEWERS_PER_RELAY_DEPARTURE).max(1) {
            // Somewhere in the second half of the arrivals or shortly after.
            let low = START_MS + (last_arrival - START_MS) / 2;
            events.push(Event {
                at: rng.range(low, last_arrival + ARRIVAL_GAP_MS.1),
                action: Action::RelayLeaves(rng.next_u64()),
            });
        }
        // Distinct instants keep one event per observation.
        events.sort_by_key(|event| event.at);
        for i in 1..events.len() {
            let floor = events[i - 1].at + QUIET_STEPS_MS[1] + 1_000;
            if events[i].at < floor {
                events[i].at = floor;
            }
        }
        Self {
            seed,
            people,
            source,
            classes,
            connectable,
            events,
        }
    }
}
