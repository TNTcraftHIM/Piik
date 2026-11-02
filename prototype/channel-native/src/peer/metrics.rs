//! Latest SDK measurements, scoped by the current Native session and flow leases.
use serde::Serialize;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeConnectionMetrics {
    pub session_id: Uuid,
    pub binding_id: Uuid,
    pub connections: Vec<PeerConnectionMetrics>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerConnectionMetrics {
    pub pair_id: Uuid,
    pub connection_id: Uuid,
    pub peer_id: Uuid,
    pub sample_timestamp_ms: Option<f64>,
    pub age_ms: Option<f64>,
    pub rtt_ms: Option<f64>,
    pub bwe_bps: Option<f64>,
    pub streams: Vec<NativeStreamMetric>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStreamMetric {
    pub flow_id: Uuid,
    pub publication_id: Uuid,
    pub selected: bool,
    pub direction: &'static str,
    pub media: &'static str,
    #[serde(flatten)]
    pub counters: StreamCounters,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamCounters {
    pub mid: String,
    pub rid: Option<String>,
    pub codec: Option<String>,
    // SDK sample time relative to this physical connection, not Browser performance time.
    pub sample_timestamp_ms: f64,
    pub age_ms: f64,
    pub bytes: u64,
    pub packets: u64,
    pub rtt_ms: Option<f64>,
    pub loss_fraction: Option<f32>,
    pub jitter_ms: Option<f64>,
}
