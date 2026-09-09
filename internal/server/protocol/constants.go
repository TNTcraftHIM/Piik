// Package protocol is the Go owner of the Screener wire contract. It mirrors
// src/shared/protocol.ts (zod schemas) plus the four shared scalar helpers
// (media-copy-accounting.ts, nat-candidate.ts, packet-loss.ts,
// video-codec-evidence.ts). The package performs no I/O and imports nothing
// from other internal packages.
package protocol

// MaxSafeInteger is JavaScript's Number.MAX_SAFE_INTEGER.
const MaxSafeInteger = 9007199254740991

// Limits and identifiers mirrored from src/shared/protocol.ts.
const (
	MaxViewersPerRoomLimit      = 20
	MaxParticipantsPerRoomLimit = MaxViewersPerRoomLimit + 1
	MaxSignalBytes              = 64 * 1024
	SignalingProtocol           = "screener-v23"
	RoomCodeLength              = 4
	MaxMediaRouteRevision       = MaxSafeInteger
	MaxIceServerURLs            = 8

	MaxNatPredictionAuxiliaryStunURLs = 2

	MaxViewerQualityEvidenceBytes       = 2 * 1024
	ViewerQualityEvidenceIntervalMs     = 2_000
	ViewerQualityEvidenceExpiryMs       = 5_000
	PersistentNativeEdgeDegradedWindows = 3

	MaxDisplayNameCodePoints     = 24
	DefaultViewerDisplayName     = "观众"
	DefaultHostDisplayNamePrefix = "分享者"

	MinViewerPasswordLength = 1
	MaxViewerPasswordLength = 64

	// MaxStunURLLength is stunUrlSchema's .max(512), in UTF-16 code units.
	MaxStunURLLength = 512
)

// Endpoint media copy accounting bounds, from src/shared/media-copy-accounting.ts.
const (
	DefaultEndpointMediaCopyCapacity = 2
	MaxEndpointMediaCopyCapacity     = 3
)

// SignalCloseCode is one of SIGNAL_CLOSE_CODES.
type SignalCloseCode int

// SIGNAL_CLOSE_CODES.
const (
	SignalCloseServiceRestart       SignalCloseCode = 1012
	SignalCloseSessionReplaced      SignalCloseCode = 4001
	SignalCloseClientReconnect      SignalCloseCode = 4002
	SignalCloseAuthenticationFailed SignalCloseCode = 4003
	SignalCloseViewerAccessRevoked  SignalCloseCode = 4004
)

// NatTraversalPaths mirrors NAT_TRAVERSAL_PATHS in src/shared/nat-candidate.ts.
var NatTraversalPaths = [...]string{"unknown", "ordinary", "predicted"}

// DefaultQualitySettings mirrors DEFAULT_QUALITY_SETTINGS.
var DefaultQualitySettings = QualitySettings{
	Resolution:            "1080p",
	MaxFramerate:          30,
	MaxBitrate:            5_000_000,
	DegradationPreference: "balanced",
	ScreenAudioQuality:    "music",
}

// DefaultRoutePolicy mirrors DEFAULT_ROUTE_POLICY.
var DefaultRoutePolicy = RoutePolicy{
	PeerOnly:             false,
	TopologyOptimization: true,
	NatPrediction:        false,
}
