package remote

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

type peer struct {
	session      *Session
	peerID       string
	slot         int
	connectionID string
	connection   *webrtc.PeerConnection

	mu                sync.Mutex
	pendingCandidates []webrtc.ICECandidateInit
	remoteDescription bool
	closeOnce         sync.Once
	firstConnected    sync.Once
	closed            atomic.Bool
	pliRequests       atomic.Uint64
	firRequests       atomic.Uint64
	diagnosticsMu     sync.Mutex
	lastSampleAt      time.Time
	lastPacketsSent   uint64
	lastBytesSent     uint64
}

type PeerDiagnostics struct {
	Slot                     int     `json:"slot"`
	ConnectionState          string  `json:"connectionState"`
	ICEConnectionState       string  `json:"iceConnectionState"`
	Route                    string  `json:"route"`
	PacketsSent              uint64  `json:"packetsSent"`
	BytesSent                uint64  `json:"bytesSent"`
	BitrateBPS               *uint64 `json:"bitrateBps,omitempty"`
	CurrentRoundTripTimeMS   *uint64 `json:"currentRoundTripTimeMs,omitempty"`
	AvailableOutgoingBitrate *uint64 `json:"availableOutgoingBitrate,omitempty"`
	PLIRequests              uint64  `json:"pliRequests"`
	FIRRequests              uint64  `json:"firRequests"`
}

func newPeer(session *Session, peerID string, slot int, configuration webrtc.Configuration) (*peer, error) {
	connectionID, err := opaqueID()
	if err != nil {
		return nil, fmt.Errorf("create connection identity: %w", err)
	}
	connection, err := webrtc.NewPeerConnection(configuration)
	if err != nil {
		return nil, errors.New("create viewer peer connection failed")
	}
	peer := &peer{
		session:      session,
		peerID:       peerID,
		slot:         slot,
		connectionID: connectionID,
		connection:   connection,
	}
	connection.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if peer.closed.Load() {
			return
		}
		payload := outboundCandidatePayload{Kind: "candidate", ConnectionID: connectionID}
		if candidate != nil {
			init := candidate.ToJSON()
			payload.Candidate = &iceCandidate{
				Candidate:        init.Candidate,
				SDPMid:           init.SDPMid,
				SDPMLineIndex:    init.SDPMLineIndex,
				UsernameFragment: init.UsernameFragment,
			}
		}
		if sendErr := session.sendSignal(peerID, payload); sendErr != nil && !session.closing.Load() {
			go session.fail(errors.New("send viewer ICE candidate failed"))
		}
	})
	connection.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if !peer.closed.Load() {
			session.emit(Event{Kind: "peer-state", Message: fmt.Sprintf("Media edge %d is %s", slot, state.String())})
			if state == webrtc.PeerConnectionStateConnected {
				peer.firstConnected.Do(func() { session.emit(Event{Kind: "request-keyframe"}) })
			}
		}
	})
	sender, err := connection.AddTrack(session.fanout.Track())
	if err != nil {
		_ = connection.Close()
		return nil, errors.New("bind shared VP8 track failed")
	}
	go peer.readRTCP(sender)
	return peer, nil
}

func (peer *peer) offer(restart bool) error {
	offer, err := peer.connection.CreateOffer(&webrtc.OfferOptions{ICERestart: restart})
	if err != nil {
		return errors.New("create viewer offer failed")
	}
	if err = peer.connection.SetLocalDescription(offer); err != nil {
		return errors.New("set viewer offer failed")
	}
	local := peer.connection.LocalDescription()
	if local == nil {
		return errors.New("viewer offer is unavailable")
	}
	if err = peer.session.sendSignal(peer.peerID, outboundDescriptionPayload{
		Kind:         "description",
		ConnectionID: peer.connectionID,
		Description: sessionDescription{
			Type: "offer",
			SDP:  local.SDP,
		},
	}); err != nil {
		return errors.New("send viewer offer failed")
	}
	return nil
}

func (peer *peer) restartICE() error {
	return peer.offer(true)
}

func (peer *peer) acceptSignal(payload inboundSignalPayload) error {
	if payload.ConnectionID != peer.connectionID {
		return nil
	}
	switch payload.Kind {
	case "description":
		if payload.Description == nil || payload.Description.Type != "answer" || payload.Description.SDP == "" {
			return errors.New("viewer returned an invalid answer")
		}
		if err := peer.connection.SetRemoteDescription(webrtc.SessionDescription{
			Type: webrtc.SDPTypeAnswer,
			SDP:  payload.Description.SDP,
		}); err != nil {
			return errors.New("apply viewer answer failed")
		}
		peer.mu.Lock()
		peer.remoteDescription = true
		pending := append([]webrtc.ICECandidateInit(nil), peer.pendingCandidates...)
		peer.pendingCandidates = nil
		peer.mu.Unlock()
		for _, candidate := range pending {
			if err := peer.connection.AddICECandidate(candidate); err != nil {
				return errors.New("apply queued viewer ICE candidate failed")
			}
		}
		return nil
	case "candidate":
		candidate := webrtc.ICECandidateInit{}
		if payload.Candidate != nil {
			candidate = webrtc.ICECandidateInit{
				Candidate:        payload.Candidate.Candidate,
				SDPMid:           payload.Candidate.SDPMid,
				SDPMLineIndex:    payload.Candidate.SDPMLineIndex,
				UsernameFragment: payload.Candidate.UsernameFragment,
			}
		}
		peer.mu.Lock()
		if !peer.remoteDescription {
			if len(peer.pendingCandidates) >= 64 {
				peer.mu.Unlock()
				return errors.New("viewer ICE candidate queue exceeded its bound")
			}
			peer.pendingCandidates = append(peer.pendingCandidates, candidate)
			peer.mu.Unlock()
			return nil
		}
		peer.mu.Unlock()
		if err := peer.connection.AddICECandidate(candidate); err != nil {
			return errors.New("apply viewer ICE candidate failed")
		}
		return nil
	default:
		return errors.New("viewer signal kind is invalid")
	}
}

func (peer *peer) readRTCP(sender *webrtc.RTPSender) {
	for {
		packets, _, err := sender.ReadRTCP()
		if err != nil {
			return
		}
		for _, packet := range packets {
			switch packet.(type) {
			case *rtcp.PictureLossIndication:
				peer.pliRequests.Add(1)
				peer.session.emit(Event{Kind: "request-keyframe"})
			case *rtcp.FullIntraRequest:
				peer.firRequests.Add(1)
				peer.session.emit(Event{Kind: "request-keyframe"})
			}
		}
	}
}

func (peer *peer) close() {
	peer.closeOnce.Do(func() {
		peer.closed.Store(true)
		_ = peer.connection.Close()
	})
}

func (peer *peer) snapshot(now time.Time) PeerDiagnostics {
	diagnostics := PeerDiagnostics{
		Slot:               peer.slot,
		ConnectionState:    peer.connection.ConnectionState().String(),
		ICEConnectionState: peer.connection.ICEConnectionState().String(),
		Route:              "unknown",
		PLIRequests:        peer.pliRequests.Load(),
		FIRRequests:        peer.firRequests.Load(),
	}
	report := peer.connection.GetStats()
	transportID := ""
	for _, value := range report {
		outbound, ok := value.(webrtc.OutboundRTPStreamStats)
		if !ok || outbound.Kind != "video" {
			continue
		}
		diagnostics.PacketsSent += uint64(outbound.PacketsSent)
		diagnostics.BytesSent += outbound.BytesSent
		if transportID == "" {
			transportID = outbound.TransportID
		}
	}
	if transport, ok := report[transportID].(webrtc.TransportStats); ok {
		if pair, pairOK := report[transport.SelectedCandidatePairID].(webrtc.ICECandidatePairStats); pairOK {
			diagnostics.Route = selectedRoute(report, pair)
			if pair.CurrentRoundTripTime > 0 {
				value := uint64(pair.CurrentRoundTripTime*1000 + 0.5)
				diagnostics.CurrentRoundTripTimeMS = &value
			}
			if pair.AvailableOutgoingBitrate > 0 {
				value := uint64(pair.AvailableOutgoingBitrate + 0.5)
				diagnostics.AvailableOutgoingBitrate = &value
			}
		}
	}
	peer.diagnosticsMu.Lock()
	if !peer.lastSampleAt.IsZero() && now.After(peer.lastSampleAt) &&
		diagnostics.BytesSent >= peer.lastBytesSent && diagnostics.PacketsSent >= peer.lastPacketsSent {
		seconds := now.Sub(peer.lastSampleAt).Seconds()
		value := uint64(float64(diagnostics.BytesSent-peer.lastBytesSent)*8/seconds + 0.5)
		diagnostics.BitrateBPS = &value
	}
	peer.lastSampleAt = now
	peer.lastPacketsSent = diagnostics.PacketsSent
	peer.lastBytesSent = diagnostics.BytesSent
	peer.diagnosticsMu.Unlock()
	return diagnostics
}

func selectedRoute(report webrtc.StatsReport, pair webrtc.ICECandidatePairStats) string {
	local, localOK := report[pair.LocalCandidateID].(webrtc.ICECandidateStats)
	remote, remoteOK := report[pair.RemoteCandidateID].(webrtc.ICECandidateStats)
	if localOK && local.CandidateType == webrtc.ICECandidateTypeRelay {
		return "turn-" + relayTransport(local)
	}
	if remoteOK && remote.CandidateType == webrtc.ICECandidateTypeRelay {
		return "turn-unknown"
	}
	if !localOK || !remoteOK {
		return "unknown"
	}
	return "direct-" + candidateProtocol(local)
}

func relayTransport(candidate webrtc.ICECandidateStats) string {
	switch strings.ToLower(candidate.RelayProtocol) {
	case "udp", "tcp", "tls":
		return strings.ToLower(candidate.RelayProtocol)
	default:
		return "unknown"
	}
}

func candidateProtocol(candidate webrtc.ICECandidateStats) string {
	if protocol := strings.ToLower(candidate.Protocol); protocol == "udp" || protocol == "tcp" {
		return protocol
	}
	return "unknown"
}

func opaqueID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}
