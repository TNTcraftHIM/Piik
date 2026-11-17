use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
fn limits() -> Limits {
    Limits {
        manifest_bytes: 1024 * 1024,
        resources: 32768,
        heap_bytes: 64 * 1024 * 1024,
        stack_bytes: 1024 * 1024,
    }
}
fn base() -> Url {
    Url::parse("https://owned.invalid/root.mpd").unwrap()
}
#[test]
fn opaque_selected_resources_and_static_input_remain_source_owned() {
    let xml = include_str!("../fixtures/bbb.mpd").to_owned();
    let doc = MpdSnapshot::inspect(
        Uuid::new_v4(),
        xml.clone(),
        base(),
        limits(),
        Arc::new(|| false),
    )
    .unwrap();
    let selected: Vec<_> = doc
        .choices()
        .iter()
        .filter(|c| {
            matches!(
                c.info.label.as_str(),
                "bbb_30fps_1280x720_4000k" | "bbb_a64k"
            )
        })
        .map(|c| c.id)
        .collect();
    let tracks = doc.resolve_selected(&selected).unwrap();
    assert_eq!(tracks.len(), 2);
    assert_eq!(tracks.iter().map(|t| t.segments.len()).sum::<usize>(), 318);
    assert!(tracks
        .iter()
        .flat_map(ResolvedTrack::resources)
        .all(|r| !r.url.contains("8000k")));
    let replacement =
        MpdSnapshot::inspect(Uuid::new_v4(), xml, base(), limits(), Arc::new(|| false)).unwrap();
    assert!(replacement
        .resolve_selected(&selected)
        .err()
        .unwrap()
        .to_string()
        .contains("source_changed"));
}
#[test]
fn active_cancellation_interrupts_native_parser_and_subsequent_parse_succeeds() {
    let stopped = Arc::new(AtomicBool::new(false));
    let signal = stopped.clone();
    let thread = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(5));
        signal.store(true, Ordering::Relaxed)
    });
    let result = MpdSnapshot::inspect(
        Uuid::new_v4(),
        include_str!("../fixtures/bbb.mpd").into(),
        base(),
        limits(),
        Arc::new(move || stopped.load(Ordering::Relaxed)),
    );
    thread.join().unwrap();
    assert_eq!(result.err().unwrap().to_string(), "watch_source_retired");
    assert!(MpdSnapshot::inspect(
        Uuid::new_v4(),
        include_str!("../fixtures/envivio.mpd").into(),
        base(),
        limits(),
        Arc::new(|| false)
    )
    .is_ok());
}
#[test]
fn engine_budget_and_manifest_limit_fail_closed_without_leaking_xml() {
    let mut small = limits();
    small.heap_bytes = 32 * 1024;
    let result = MpdSnapshot::inspect(
        Uuid::new_v4(),
        include_str!("../fixtures/bbb.mpd").into(),
        base(),
        small,
        Arc::new(|| false),
    );
    assert!(result.is_err());
    let mut input = limits();
    input.manifest_bytes = 1;
    assert_eq!(
        MpdSnapshot::inspect(
            Uuid::new_v4(),
            "secret-source".into(),
            base(),
            input,
            Arc::new(|| false)
        )
        .err()
        .unwrap()
        .to_string(),
        "watch_manifest_limit"
    );
}
#[test]
fn parser_has_no_network_file_process_or_module_capability() {
    let rt = Runtime::new().unwrap();
    let ctx = Context::full(&rt).unwrap();
    ctx.with(|c| {let absent:bool=c.eval("['fetch','XMLHttpRequest','require','process','std','os'].every(k=>typeof globalThis[k]==='undefined')").unwrap();assert!(absent)});
}
#[test]
fn logical_tracks_cover_all_periods_and_serialize_selected_closure() {
    let xml = include_str!("../fixtures/clear-multiperiod.mpd").to_owned();
    let doc =
        MpdSnapshot::inspect(Uuid::new_v4(), xml, base(), limits(), Arc::new(|| false)).unwrap();
    assert_eq!(doc.choices().len(), 5);
    let ids = ["default_video1200_1_960x540", "default_audio96_2"].map(|label| {
        doc.choices()
            .iter()
            .find(|c| c.info.label == label)
            .unwrap()
            .id
    });
    let tracks = doc.resolve_selected(&ids).unwrap();
    assert_eq!(tracks.len(), 10);
    let mut mapping = std::collections::BTreeMap::new();
    for r in tracks.iter().flat_map(ResolvedTrack::resources) {
        mapping.entry(r.url.clone()).or_insert_with(Uuid::new_v4);
    }
    let xml = doc.serialize_selected(&ids, &mapping).unwrap();
    assert_eq!(xml.matches("<Period ").count(), 5);
    assert_eq!(xml.matches("<Representation ").count(), 10);
    assert!(!xml.contains("default_video2000"));
    assert!(!xml.contains("https://example.com"));
    assert!(xml.contains("SegmentTimeline"));
}
#[test]
fn declared_unsupported_and_malformed_sources_have_fixed_distinct_errors() {
    let xml = include_str!("../fixtures/bbb.mpd");
    let unsupported = MpdSnapshot::inspect(
        Uuid::new_v4(),
        xml.replace("type=\"static\"", "type=\"dynamic\""),
        base(),
        limits(),
        Arc::new(|| false),
    );
    assert_eq!(
        unsupported.err().unwrap().to_string(),
        "watch_mpd_unsupported"
    );
    let malformed = MpdSnapshot::inspect(
        Uuid::new_v4(),
        "<not-mpd>private-query-token".into(),
        base(),
        limits(),
        Arc::new(|| false),
    );
    assert_eq!(malformed.err().unwrap().to_string(), "watch_mpd_invalid");
}
