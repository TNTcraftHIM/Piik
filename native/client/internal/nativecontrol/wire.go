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
type listWindowsRequest requestEnvelope

type startShareRequest struct {
	Version      int                        `json:"version"`
	ID           string                     `json:"id"`
	Type         string                     `json:"type"`
	ShareID      string                     `json:"shareId"`
	Window       nativecapture.WindowTarget `json:"window"`
	AdapterIndex uint32                     `json:"adapterIndex"`
	EncoderIndex uint32                     `json:"encoderIndex"`
	EdgeCapacity int                        `json:"edgeCapacity"`
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

type windowListResponse struct {
	responseEnvelope
	Windows []nativecapture.WindowTarget `json:"windows"`
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

type shareEndedEvent struct {
	Version int    `json:"version"`
	Type    string `json:"type"`
	ShareID string `json:"shareId"`
	Failed  bool   `json:"failed"`
}
