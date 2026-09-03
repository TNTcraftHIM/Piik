package nativecontrol

import (
	"github.com/TNTcraftHIM/Screener/native/client/internal/nativecapture"
	"github.com/pion/webrtc/v4"
)

type requestEnvelope struct {
	Version int    `json:"version"`
	ID      string `json:"id"`
	Type    string `json:"type"`
}

type responseEnvelope struct {
	Version int    `json:"version"`
	ID      string `json:"id"`
	Type    string `json:"type"`
}

type captureOptionsRequest requestEnvelope
type listSourcesRequest requestEnvelope

type sourcePreviewRequest struct {
	Version int                         `json:"version"`
	ID      string                      `json:"id"`
	Type    string                      `json:"type"`
	Source  nativecapture.CaptureTarget `json:"source"`
}

type startShareRequest struct {
	Version      int                         `json:"version"`
	ID           string                      `json:"id"`
	Type         string                      `json:"type"`
	ShareID      string                      `json:"shareId"`
	Source       nativecapture.CaptureTarget `json:"source"`
	Audio        bool                        `json:"audio"`
	AdapterIndex uint32                      `json:"adapterIndex"`
	EncoderIndex uint32                      `json:"encoderIndex"`
	EdgeCapacity int                         `json:"edgeCapacity"`
}

type stopShareRequest struct {
	Version int    `json:"version"`
	ID      string `json:"id"`
	Type    string `json:"type"`
	ShareID string `json:"shareId"`
}

type pauseShareRequest struct {
	Version int    `json:"version"`
	ID      string `json:"id"`
	Type    string `json:"type"`
	ShareID string `json:"shareId"`
	Paused  bool   `json:"paused"`
}

type iceServer struct {
	URLs []string `json:"urls"`
}

type prepareEdgeRequest struct {
	Version      int         `json:"version"`
	ID           string      `json:"id"`
	Type         string      `json:"type"`
	ShareID      string      `json:"shareId"`
	ConnectionID string      `json:"connectionId"`
	ICEServers   []iceServer `json:"iceServers"`
}

type prepareLocalEdgeRequest struct {
	Version      int    `json:"version"`
	ID           string `json:"id"`
	Type         string `json:"type"`
	ShareID      string `json:"shareId"`
	ConnectionID string `json:"connectionId"`
}

type edgeAnswerRequest struct {
	Version      int    `json:"version"`
	ID           string `json:"id"`
	Type         string `json:"type"`
	ShareID      string `json:"shareId"`
	ConnectionID string `json:"connectionId"`
	SDP          string `json:"sdp"`
}

type edgeCandidateRequest struct {
	Version      int                      `json:"version"`
	ID           string                   `json:"id"`
	Type         string                   `json:"type"`
	ShareID      string                   `json:"shareId"`
	ConnectionID string                   `json:"connectionId"`
	Candidate    *webrtc.ICECandidateInit `json:"candidate"`
}

type closeEdgeRequest struct {
	Version      int    `json:"version"`
	ID           string `json:"id"`
	Type         string `json:"type"`
	ShareID      string `json:"shareId"`
	ConnectionID string `json:"connectionId"`
}

type sourceListResponse struct {
	responseEnvelope
	Sources []nativecapture.CaptureTarget `json:"sources"`
}

type sourcePreviewResponse struct {
	responseEnvelope
	SourceKey string `json:"sourceKey"`
	Mime      string `json:"mime"`
	Data      string `json:"data"`
}

type captureOptionsResponse struct {
	responseEnvelope
	Adapters []nativecapture.Adapter `json:"adapters"`
}

type shareStartedResponse struct {
	responseEnvelope
	ShareID string `json:"shareId"`
	Audio   bool   `json:"audio"`
}

type edgeOfferResponse struct {
	responseEnvelope
	ShareID      string `json:"shareId"`
	ConnectionID string `json:"connectionId"`
	SDP          string `json:"sdp"`
}

type eventEnvelope struct {
	Version      int    `json:"version"`
	Type         string `json:"type"`
	ShareID      string `json:"shareId"`
	ConnectionID string `json:"connectionId,omitempty"`
}

type captureStateEvent struct {
	eventEnvelope
	State string `json:"state"`
}

type edgeCandidateEvent struct {
	eventEnvelope
	Candidate *webrtc.ICECandidateInit `json:"candidate"`
}

type edgeStateEvent struct {
	eventEnvelope
	State string `json:"state"`
}

type edgePathEvent struct {
	eventEnvelope
	LocalType  string `json:"localType"`
	RemoteType string `json:"remoteType"`
}

type edgeQualityEvent struct {
	eventEnvelope
	SampleTimestampMs     int64   `json:"sampleTimestampMs"`
	SampleWindowMs        int64   `json:"sampleWindowMs"`
	RTPStatsID            string  `json:"rtpStatsId"`
	TrackIdentifier       string  `json:"trackIdentifier"`
	State                 string  `json:"state"`
	Reason                *string `json:"reason"`
	IntervalFramesEncoded uint64  `json:"intervalFramesEncoded"`
	FramesPerSecond       float64 `json:"framesPerSecond"`
	BitrateKbps           float64 `json:"bitrateKbps"`
	AvailableOutgoingKbps float64 `json:"availableOutgoingKbps"`
	Width                 uint32  `json:"width"`
	Height                uint32  `json:"height"`
}

type shareEndedEvent struct {
	Version int    `json:"version"`
	Type    string `json:"type"`
	ShareID string `json:"shareId"`
	Failed  bool   `json:"failed"`
}
