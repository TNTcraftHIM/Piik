package nativecontrol

import (
	"github.com/TNTcraftHIM/Piik/internal/app/mediaedge"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
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

type requestFailedResponse struct {
	responseEnvelope
	Code string `json:"code"`
}

type captureOptionsRequest requestEnvelope
type listSourcesRequest requestEnvelope

type sourcePreviewRequest struct {
	Version int                         `json:"version"`
	ID      string                      `json:"id"`
	Type    string                      `json:"type"`
	Source  nativecapture.CaptureTarget `json:"source"`
}

type qualitySettings struct {
	Resolution            string `json:"resolution"`
	MaxFramerate          uint32 `json:"maxFramerate"`
	MaxBitrate            uint32 `json:"maxBitrate"`
	DegradationPreference string `json:"degradationPreference"`
	ScreenAudioQuality    string `json:"screenAudioQuality,omitempty"`
}

type startShareRequest struct {
	Version           int                         `json:"version"`
	ID                string                      `json:"id"`
	Type              string                      `json:"type"`
	ShareID           string                      `json:"shareId"`
	Source            nativecapture.CaptureTarget `json:"source"`
	Audio             bool                        `json:"audio"`
	MicrophoneMixing  bool                        `json:"microphoneMixing,omitempty"`
	ShowCaptureBorder bool                        `json:"showCaptureBorder,omitempty"`
	AdapterIndex      uint32                      `json:"adapterIndex"`
	EncoderIndex      uint32                      `json:"encoderIndex"`
	EdgeCapacity      int                         `json:"edgeCapacity"`
	Profile           qualitySettings             `json:"profile"`
	Codec             string                      `json:"codec"`
}

type microphoneRequest struct {
	requestEnvelope
	ShareID  string   `json:"shareId"`
	Enabled  *bool    `json:"enabled,omitempty"`
	Volume   *float64 `json:"volume,omitempty"`
	DeviceID *string  `json:"deviceId,omitempty"`
}

type audioStateEvent struct {
	eventEnvelope
	SourceAudio bool `json:"sourceAudio"`
	Microphone  bool `json:"microphone"`
	Failed      bool `json:"failed"`
}

type updateShareRequest struct {
	Version int             `json:"version"`
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	ShareID string          `json:"shareId"`
	Profile qualitySettings `json:"profile"`
}

type replaceShareSourceRequest struct {
	Version           int                         `json:"version"`
	ID                string                      `json:"id"`
	Type              string                      `json:"type"`
	ShareID           string                      `json:"shareId"`
	Source            nativecapture.CaptureTarget `json:"source"`
	Audio             bool                        `json:"audio"`
	ShowCaptureBorder bool                        `json:"showCaptureBorder,omitempty"`
	AdapterIndex      uint32                      `json:"adapterIndex"`
	EncoderIndex      uint32                      `json:"encoderIndex"`
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
	Version            int         `json:"version"`
	ID                 string      `json:"id"`
	Type               string      `json:"type"`
	ShareID            string      `json:"shareId"`
	ConnectionID       string      `json:"connectionId"`
	SourceConnectionID string      `json:"sourceConnectionId,omitempty"`
	ICEServers         []iceServer `json:"iceServers"`
}

type prepareLocalEdgeRequest struct {
	Version            int    `json:"version"`
	ID                 string `json:"id"`
	Type               string `json:"type"`
	ShareID            string `json:"shareId"`
	ConnectionID       string `json:"connectionId"`
	SourceConnectionID string `json:"sourceConnectionId,omitempty"`
}

type receiveOfferRequest struct {
	Version       int         `json:"version"`
	ID            string      `json:"id"`
	Type          string      `json:"type"`
	ShareID       string      `json:"shareId"`
	ConnectionID  string      `json:"connectionId"`
	EdgeCapacity  int         `json:"edgeCapacity"`
	ICEServers    []iceServer `json:"iceServers"`
	SDP           string      `json:"sdp"`
	ReuseReceiver bool        `json:"reuseReceiver,omitempty"`
}

type receiveCandidateRequest struct {
	Version      int                      `json:"version"`
	ID           string                   `json:"id"`
	Type         string                   `json:"type"`
	ShareID      string                   `json:"shareId"`
	ConnectionID string                   `json:"connectionId"`
	Candidate    *webrtc.ICECandidateInit `json:"candidate"`
}

type closeReceiverRequest struct {
	Version      int    `json:"version"`
	ID           string `json:"id"`
	Type         string `json:"type"`
	ShareID      string `json:"shareId"`
	ConnectionID string `json:"connectionId"`
}

type stopReceiveRequest struct {
	Version int    `json:"version"`
	ID      string `json:"id"`
	Type    string `json:"type"`
	ShareID string `json:"shareId"`
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
	ShareID     string `json:"shareId"`
	Audio       bool   `json:"audio"`
	SourceAudio *bool  `json:"sourceAudio,omitempty"`
	Codec       string `json:"codec"`
}

type shareUpdatedResponse struct {
	responseEnvelope
	ShareID string `json:"shareId"`
}

type shareSourceReplacedResponse struct {
	responseEnvelope
	ShareID string `json:"shareId"`
}

type edgeOfferResponse struct {
	responseEnvelope
	ShareID      string `json:"shareId"`
	ConnectionID string `json:"connectionId"`
	SDP          string `json:"sdp"`
}

type receiveAnswerResponse struct {
	responseEnvelope
	ShareID      string `json:"shareId"`
	ConnectionID string `json:"connectionId"`
	SDP          string `json:"sdp"`
	Audio        bool   `json:"audio"`
	Codec        string `json:"codec"`
	Reused       *bool  `json:"reused,omitempty"`
}

type eventEnvelope struct {
	Version               int    `json:"version"`
	Type                  string `json:"type"`
	ShareID               string `json:"shareId"`
	ConnectionID          string `json:"connectionId,omitempty"`
	PublicationGeneration string `json:"publicationGeneration,omitempty"`
}

type publicationIdentity struct {
	requestEnvelope
	ShareID               string `json:"shareId"`
	PublicationGeneration string `json:"publicationGeneration"`
	ConnectionID          string `json:"connectionId"`
}

type preparePublicationRequest struct {
	publicationIdentity
	ICEServers []iceServer `json:"iceServers"`
}

type publicationAnswerRequest struct {
	publicationIdentity
	SDP string `json:"sdp"`
}

type publicationCandidateRequest struct {
	publicationIdentity
	Candidate *webrtc.ICECandidateInit `json:"candidate"`
}

type publicationLayersRequest struct {
	publicationIdentity
	ActiveCount *int `json:"activeCount"`
}

type publicationResponse struct {
	responseEnvelope
	ShareID               string                     `json:"shareId"`
	PublicationGeneration string                     `json:"publicationGeneration"`
	ConnectionID          string                     `json:"connectionId"`
	SDP                   string                     `json:"sdp,omitempty"`
	Media                 mediaedge.PublicationMedia `json:"media"`
}

type publicationQualityEvent struct {
	eventEnvelope
	mediaedge.PublicationQualitySample
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
	LocalType        string `json:"localType"`
	RemoteType       string `json:"remoteType"`
	NatTraversalPath string `json:"natTraversalPath"`
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
