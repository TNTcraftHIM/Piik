/// Select original QPC timestamps (100 ns units); never retimestamp frames.
pub(super) struct Cadence {
    interval: i64,
    next: Option<i64>,
}
impl Cadence {
    pub fn new(fps: u32) -> Self {
        Self {
            interval: 10_000_000 / fps as i64,
            next: None,
        }
    }
    pub fn accept(&mut self, timestamp: i64) -> bool {
        // Accumulate deadlines rather than measuring from the last selected frame.
        // The half-period phase and idle reset follow libwebrtc's cadence policy:
        // https://webrtc.googlesource.com/src/+/59947d28711f9ecec460e7ae83a769be5bd70794/common_video/framerate_controller.cc
        let next = self.next.get_or_insert(timestamp - self.interval / 2);
        if timestamp.abs_diff(*next) >= 2 * self.interval as u64 {
            *next = timestamp - self.interval / 2;
        }
        if timestamp < *next {
            return false;
        }
        *next += self.interval;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::Cadence;

    #[test]
    fn twenty_input_frames_per_second_produce_fifteen() {
        let mut cadence = Cadence::new(15);
        let kept = (0..200)
            .filter(|frame| cadence.accept(frame * 500_000))
            .count();
        assert_eq!(kept, 150);

        // Idle capture resumes immediately, without accumulating a catch-up burst.
        let resumed = 200_000_000;
        assert!(cadence.accept(resumed));
        assert!(!cadence.accept(resumed + 1));
        assert!(cadence.accept(resumed + 500_000));
    }

    #[test]
    fn sixty_to_thirty_keeps_rate_under_submillisecond_jitter() {
        let mut cadence = Cadence::new(30);
        let kept = (0..600)
            .map(|frame| 10_000_000 + frame * 10_000_000 / 60 + (frame % 3 - 1) * 1_000)
            .filter(|timestamp| cadence.accept(*timestamp))
            .count();
        assert!((300..=301).contains(&kept), "kept {kept} of 600 frames");
    }
}
