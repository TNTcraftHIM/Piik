use piik_channel_mpd::{Cancelled, Limits, MpdSnapshot};
use std::{
    collections::BTreeSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use url::Url;
use uuid::Uuid;

#[test]
fn selected_segment_base_ranges_match_actual_shaka_reads_and_retired_choices_do_not_cross_snapshots(
) -> anyhow::Result<()> {
    let xml = include_str!("../fixtures/angel-one.mpd");
    let base = Url::parse("https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd")?;
    let limits = Limits {
        manifest_bytes: 1024 * 1024,
        resources: 32768,
        heap_bytes: 64 * 1024 * 1024,
        stack_bytes: 1024 * 1024,
    };
    let stopped = Arc::new(AtomicBool::new(false));
    let flag = stopped.clone();
    let cancelled: Cancelled = Arc::new(move || flag.load(Ordering::Relaxed));
    let old_root = Uuid::new_v4();
    let old = MpdSnapshot::inspect(old_root, xml.into(), base.clone(), limits, cancelled)?;
    let ids = ["11", "5"].map(|label| {
        old.choices()
            .iter()
            .find(|choice| choice.info.label == label)
            .unwrap()
            .id
    });
    let tracks = old.resolve_selected(&ids)?;
    assert_eq!(tracks.len(), 2);
    let expected = [
        ("video_144p_96k_vp9.webm", 310, 243, 0, 310),
        ("audio_de_2c_128k_aac.mp4", 786, 212, 0, 786),
    ];
    let mut reads = Vec::new();
    let mut resources = BTreeSet::new();
    for (track, (file, index_offset, index_length, init_offset, init_length)) in
        tracks.iter().zip(expected)
    {
        assert!(
            track.segments.is_empty(),
            "Index parsing belongs to the viewer; no eager media expansion"
        );
        let expected_url = base.join(file)?.to_string();
        for (resource, offset, length) in [
            (
                track.index_resource.as_ref().unwrap(),
                index_offset,
                index_length,
            ),
            (track.index_init.as_ref().unwrap(), init_offset, init_length),
        ] {
            assert_eq!(resource.url, expected_url);
            let range = resource.range.as_ref().unwrap();
            assert_eq!((range.offset, range.length), (offset, length));
            assert!(length <= 65536);
            resources.insert(resource.url.clone());
            // A test-only I/O schedule, not a second Native reader or index parser.
            reads.push((resource.url.clone(), offset, length));
        }
    }
    assert_eq!(resources.len(), 2);
    assert_eq!(reads.len(), 4);
    assert_eq!(reads.iter().map(|r| r.2).sum::<u64>(), 1551);
    stopped.store(true, Ordering::Relaxed);
    assert!(
        matches!(old.resolve_selected(&ids), Err(error) if error.to_string() == "watch_source_retired")
    );
    let next = MpdSnapshot::inspect(Uuid::new_v4(), xml.into(), base, limits, Arc::new(|| false))?;
    assert_ne!(next.source_id, old_root);
    assert!(
        matches!(next.resolve_selected(&ids), Err(error) if error.to_string() == "watch_source_changed")
    );
    Ok(())
}
