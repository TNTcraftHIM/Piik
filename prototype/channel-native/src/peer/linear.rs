//! One pair-wide batch of hypotheses from a real IPv4 base.
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, SocketAddrV4};
use str0m::Candidate;

struct Sample {
    server: SocketAddr,
    mapped: Option<SocketAddr>,
}

pub(super) struct Linear {
    ufrag: String,
    cohorts: Option<HashMap<SocketAddr, Cohort>>,
}

impl Linear {
    pub fn new(ufrag: String) -> Self {
        Self {
            ufrag,
            cohorts: Some(HashMap::new()),
        }
    }

    pub fn ufrag(&self) -> &str {
        &self.ufrag
    }

    pub fn sent(&mut self, local: SocketAddr, server: SocketAddr) -> Option<usize> {
        self.cohorts
            .as_mut()?
            .entry(local)
            .or_insert_with(Cohort::new)
            .sent(server)
    }

    pub fn candidates(
        &mut self,
        local: SocketAddr,
        slot: Option<usize>,
        mapped: Option<SocketAddr>,
        registered: Option<Candidate>,
    ) -> anyhow::Result<Vec<Candidate>> {
        let Some(cohort) = self
            .cohorts
            .as_mut()
            .and_then(|cohorts| cohorts.get_mut(&local))
        else {
            return Ok(vec![]);
        };
        let candidates = cohort.candidates(slot, mapped, registered)?;
        if !candidates.is_empty() {
            self.retire();
        }
        Ok(candidates)
    }

    pub fn retire(&mut self) {
        self.cohorts = None;
    }
}

struct Cohort {
    samples: Option<Vec<Sample>>,
    templates: HashMap<IpAddr, Candidate>,
}

impl Cohort {
    fn new() -> Self {
        Self {
            samples: Some(Vec::with_capacity(3)),
            templates: HashMap::new(),
        }
    }

    // Called once per original transaction, immediately after its first
    // successful UDP send. Completion order cannot replace this cohort.
    fn sent(&mut self, server: SocketAddr) -> Option<usize> {
        let samples = self.samples.as_mut()?;
        if samples.len() == 3 || samples.iter().any(|sample| sample.server == server) {
            return None;
        }
        let slot = samples.len();
        samples.push(Sample {
            server,
            mapped: None,
        });
        Some(slot)
    }

    // RTC exposes the registered candidate only on first insertion. Keep one
    // template per observed IP until this single base's cohort resolves.
    fn candidates(
        &mut self,
        slot: Option<usize>,
        mapped: Option<SocketAddr>,
        registered: Option<Candidate>,
    ) -> anyhow::Result<Vec<Candidate>> {
        if self.samples.is_none() {
            return Ok(vec![]);
        }
        if let Some(candidate) = registered {
            self.templates.insert(candidate.addr().ip(), candidate);
        }
        let targets = self.resolved(slot, mapped);
        if self.samples.is_some() {
            return Ok(vec![]);
        }
        let templates = std::mem::take(&mut self.templates);
        let Some(template) = mapped.and_then(|addr| templates.get(&addr.ip())) else {
            return Ok(vec![]);
        };
        targets
            .into_iter()
            .map(|target| hypothesis(template, target))
            .collect()
    }

    fn resolved(&mut self, slot: Option<usize>, mapped: Option<SocketAddr>) -> Vec<SocketAddrV4> {
        let Some(slot) = slot else {
            return vec![];
        };
        let Some(mapped) = mapped else {
            self.samples = None;
            return vec![];
        };
        let Some(samples) = self.samples.as_mut() else {
            return vec![];
        };
        samples[slot].mapped = Some(mapped);
        if samples.len() != 3 || samples.iter().any(|sample| sample.mapped.is_none()) {
            return vec![];
        }
        let samples = self.samples.take().unwrap();
        let addresses: Vec<_> = samples
            .into_iter()
            .map(|sample| sample.mapped.unwrap())
            .collect();
        let [SocketAddr::V4(first), SocketAddr::V4(middle), SocketAddr::V4(last)] =
            addresses.as_slice()
        else {
            return vec![];
        };
        let step = i32::from(middle.port()) - i32::from(first.port());
        let observation = piik_channel_core::wire::UdpObservation::Irregular {
            address: *first.ip(),
        };
        if !observation.valid()
            || first.ip() != middle.ip()
            || middle.ip() != last.ip()
            || step == 0
            || !(-16..=16).contains(&step)
            || i32::from(last.port()) - i32::from(middle.port()) != step
        {
            return vec![];
        }
        (1..=8)
            .map(|n| i32::from(first.port()) - n * step)
            .chain((1..=8).map(|n| i32::from(last.port()) + n * step))
            .filter_map(|port| u16::try_from(port).ok().filter(|port| *port >= 1024))
            .map(|port| SocketAddrV4::new(*first.ip(), port))
            .collect()
    }
}

// This value is only signaled to the peer. It is never registered as a real
// local mapping in the sending RTC. Foundation, priority and ufrag stay intact.
pub(super) fn hypothesis(template: &Candidate, target: SocketAddrV4) -> anyhow::Result<Candidate> {
    let sdp = template.to_sdp_string();
    let mut fields: Vec<_> = sdp.split_whitespace().map(str::to_owned).collect();
    fields[5] = target.port().to_string();
    if let Some(index) = fields.iter().position(|field| field == "raddr") {
        fields[index + 1] = "0.0.0.0".into();
    }
    if let Some(index) = fields.iter().position(|field| field == "rport") {
        fields[index + 1] = "0".into();
    }
    Ok(Candidate::from_sdp_string(&fields.join(" "))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_sent_cohort_keeps_response_order_and_one_batch() {
        let mut linear = Cohort::new();
        let servers: Vec<SocketAddr> = (1..=4)
            .map(|port| SocketAddr::from(([192, 0, 2, 2], port)))
            .collect();
        let slots: Vec<_> = servers.iter().map(|server| linear.sent(*server)).collect();
        assert_eq!(slots, [Some(0), Some(1), Some(2), None]);
        let address = |port| Some(SocketAddr::from(([203, 0, 113, 1], port)));
        assert!(linear.resolved(slots[3], address(40003)).is_empty());
        assert!(linear.resolved(slots[2], address(40002)).is_empty());
        assert!(linear.resolved(slots[1], address(40001)).is_empty());
        let targets = linear.resolved(slots[0], address(40000));
        assert_eq!(
            targets.iter().map(|a| a.port()).collect::<Vec<_>>(),
            (39992..40000)
                .rev()
                .chain(40003..=40010)
                .collect::<Vec<_>>()
        );
        assert!(linear.resolved(slots[0], address(40000)).is_empty());
        let mut failed = Cohort::new();
        for server in &servers[..3] {
            failed.sent(*server);
        }
        assert!(failed.resolved(Some(0), None).is_empty());
        assert!(failed.resolved(Some(1), address(40001)).is_empty());
        assert!(failed.resolved(Some(2), address(40002)).is_empty());
    }
}
