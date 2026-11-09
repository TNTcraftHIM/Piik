use super::*;
use crate::capture::cadence::Cadence;

fn settings() -> Settings {
    Settings {
        width: 640,
        height: 360,
        fps: 30,
        bitrate: 1_500_000,
        degradation_preference: Mode::Balanced,
    }
}

fn samples(policy: &mut QualityPolicy, qp: i32, at_ms: u64) {
    for offset in 0..60 {
        policy.report_encoded(Some(qp), (at_ms + offset * 10) * 1_000);
    }
}

#[test]
fn balanced_restrictions_and_recovery_match_the_pinned_cpp_trace() {
    // Expected decisions from the actual upstream C++ fixture at the pin in
    // native/third_party/webrtc-adaptation, including FPS before pixel recovery.
    for codec in [Codec::Vp8, Codec::H264] {
        let high = if codec == Codec::Vp8 { 110 } else { 45 };
        let mut policy = QualityPolicy::new(codec, Mode::Balanced, 0);
        let mut now = 0;
        for (pixels, fps, qp, max_pixels, target_pixels, max_fps, resolutions, rates) in [
            (230_400, 30, high, None, None, Some(15), 0, 1),
            (230_400, 30, high, Some(138_240), None, Some(15), 1, 1),
            (230_400, 30, high, Some(138_240), None, Some(15), 1, 1),
            (138_240, 15, high, Some(138_240), None, Some(10), 1, 2),
            (138_240, 10, high, Some(82_944), None, Some(10), 2, 2),
            (82_944, 10, high, Some(82_944), None, Some(10), 2, 2),
            (82_944, 10, 10, Some(82_944), None, Some(15), 2, 1),
            (82_944, 15, 10, Some(331_776), Some(138_240), Some(15), 1, 1),
            (138_240, 15, 10, None, None, Some(15), 0, 1),
            (230_400, 15, 10, None, None, None, 0, 0),
        ] {
            samples(&mut policy, qp, now + 1);
            now += if now == 0 { 2_000 } else { 5_000 };
            policy.tick(now, Input { pixels, fps });
            assert_eq!(
                policy.restrictions(),
                Restrictions {
                    max_pixels,
                    target_pixels,
                    max_fps
                }
            );
            assert_eq!(
                (
                    policy.adaptation.resolution_adaptations,
                    policy.adaptation.fps_adaptations
                ),
                (resolutions, rates)
            );
        }
    }
}

#[test]
fn motion_waits_for_applied_size_and_codec_qp_scales_remain_distinct() {
    for (codec, high_threshold) in [(Codec::Vp8, 95), (Codec::H264, 37)] {
        let mut policy = QualityPolicy::new(codec, Mode::MaintainFramerate, 0);
        let input = Input {
            pixels: 230_400,
            fps: 30,
        };
        samples(&mut policy, high_threshold, 0);
        policy.tick(2_000, input);
        assert_eq!(policy.restrictions(), Restrictions::default());
        // A fresh constant-QP generation isolates the strict threshold boundary.
        let mut policy = QualityPolicy::new(codec, Mode::MaintainFramerate, 0);
        samples(&mut policy, high_threshold + 1, 0);
        policy.tick(2_000, input);
        assert_eq!(policy.restrictions().max_pixels, Some(138_240));
        samples(&mut policy, high_threshold + 1, 2_001);
        policy.tick(7_000, input);
        assert_eq!(policy.adaptation.resolution_adaptations, 1);
        samples(&mut policy, 10, 7_001);
        policy.tick(
            12_000,
            Input {
                pixels: 138_240,
                ..input
            },
        );
        assert_eq!(policy.restrictions(), Restrictions::default());
    }
}

#[test]
fn missing_qp_does_not_invent_samples_but_real_drops_still_count() {
    let input = Input {
        pixels: 230_400,
        fps: 30,
    };
    let mut policy = QualityPolicy::new(Codec::H264, Mode::MaintainFramerate, 0);
    for at in 0..150 {
        policy.report_encoded(None, at * 10_000);
    }
    policy.tick(2_000, input);
    assert_eq!(policy.drops.count, 0);
    assert_eq!(policy.restrictions(), Restrictions::default());
    for _ in 0..60 {
        policy.report_drop();
    }
    policy.tick(4_000, input);
    assert_eq!(policy.restrictions().max_pixels, Some(138_240));

    let mut detail = QualityPolicy::new(Codec::H264, Mode::MaintainResolution, 0);
    samples(&mut detail, 51, 0);
    for _ in 0..150 {
        detail.report_drop();
    }
    detail.tick(2_000, input);
    assert_eq!(detail.restrictions(), Restrictions::default());
}

#[test]
fn source_fps_hint_does_not_cap_an_explicit_higher_cadence() {
    let requested = settings();
    let restriction = Restrictions {
        max_fps: Some(40),
        ..Default::default()
    };
    assert_eq!(restriction.frame_rate_limit(Some(requested.fps)), Some(30));
    assert_eq!(restriction.frame_rate_limit(None), Some(40));
    // Codec nominal FPS may remain 30 while source timestamps are admitted at 40.
    let applied = restriction.apply(requested, None);
    assert_eq!(applied.fps, 30);
    let mut cadence = Cadence::new(restriction.frame_rate_limit(None).unwrap());
    let kept = (0..600)
        .filter(|i| cadence.accept(i * 10_000_000 / 60))
        .count();
    assert!((400..=401).contains(&kept), "kept {kept} source frames");
    assert_eq!(Restrictions::default().frame_rate_limit(None), None);
    assert_eq!(Restrictions::default().apply(requested, None), requested);

    let upstream_restore = Restrictions {
        max_fps: Some(UNLIMITED - 2),
        ..Default::default()
    };
    assert_eq!(upstream_restore.frame_rate_limit(None), Some(UNLIMITED - 2));
    assert_eq!(upstream_restore.apply(requested, None).fps, 30);
    let limited = Restrictions {
        max_pixels: Some(138_240),
        max_fps: Some(15),
        ..Default::default()
    }
    .apply(requested, Some(requested.fps));
    assert_eq!(limited.fps, 15);
    assert!(limited.width * limited.height <= 138_240);
    assert_eq!(
        (requested.width, requested.height, requested.fps),
        (640, 360, 30)
    );
}

#[test]
fn balanced_rejects_the_whole_proposal_when_its_second_step_hits_the_floor() {
    let mut policy = QualityPolicy::new(Codec::Vp8, Mode::Balanced, 0);
    samples(&mut policy, 110, 0);
    policy.tick(
        2_000,
        Input {
            pixels: 80_000,
            fps: 10,
        },
    );
    assert_eq!(policy.restrictions(), Restrictions::default());
    assert_eq!(
        (
            policy.adaptation.resolution_adaptations,
            policy.adaptation.fps_adaptations
        ),
        (0, 0)
    );
}
