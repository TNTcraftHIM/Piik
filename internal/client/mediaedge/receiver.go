package mediaedge

import (
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"

	"github.com/pion/rtcp"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

type ReceiverEvents struct {
	LocalCandidate  func(*webrtc.ICECandidateInit)
	ConnectionState func(webrtc.PeerConnectionState, *SelectedPair)
}

type ReceiverOptions struct {
	Offer        webrtc.SessionDescription
	ICEServers   []webrtc.ICEServer
	EdgeCapacity int
	Events       ReceiverEvents
	Relay        *RelayOptions
}

// Receiver owns one inbound WebRTC connection and exposes its encoded media as
// ordinary bounded Sources. Consumers can attach local playback and downstream
// P2P edges without adding a decoder or encoder.
type Receiver struct {
	connection      *webrtc.PeerConnection
	source          *Source
	audioSource     *AudioSource
	events          ReceiverEvents
	localCandidates *localCandidateGathering

	mu        sync.Mutex
	closed    bool
	videoSSRC webrtc.SSRC
}

func (engine *Engine) NewReceiver(options ReceiverOptions) (*Receiver, webrtc.SessionDescription, error) {
	if options.Offer.Type != webrtc.SDPTypeOffer || options.Offer.SDP == "" {
		return nil, webrtc.SessionDescription{}, errors.New("native media receiver input is invalid")
	}
	hasAudio, err := offerSendsCodec(options.Offer.SDP, "audio", "opus")
	if err != nil {
		return nil, webrtc.SessionDescription{}, err
	}
	mappedPort := 0
	if engine.portMapping != nil && len(options.ICEServers) > 0 {
		mappedPort = engine.portMapping.Prepare()
	}
	connection, err := engine.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, webrtc.SessionDescription{}, err
	}
	if err = connection.SetRemoteDescription(options.Offer); err != nil {
		_ = connection.Close()
		return nil, webrtc.SessionDescription{}, err
	}
	videoCodec, err := selectReceiverVideoCodec(connection)
	if err != nil {
		_ = connection.Close()
		return nil, webrtc.SessionDescription{}, err
	}
	receiver := &Receiver{
		connection: connection,
		events:     options.Events,
	}
	layers := 1
	if _, supported := relayBackend(videoCodec, options.Relay); supported {
		layers = 2
	}
	receiver.source, err = engine.NewSource(videoCodec, options.EdgeCapacity, layers, receiver.RequestKeyFrame)
	if err != nil {
		_ = connection.Close()
		return nil, webrtc.SessionDescription{}, err
	}
	if layers > 1 {
		receiver.source.relay = &relayDerivation{source: receiver.source, options: *options.Relay}
	}
	if hasAudio {
		receiver.audioSource, err = engine.NewRelayedAudioSource(options.EdgeCapacity)
		if err != nil {
			_ = receiver.source.Close()
			_ = connection.Close()
			return nil, webrtc.SessionDescription{}, err
		}
	}
	receiver.localCandidates = newLocalCandidateGathering(
		engine,
		options.ICEServers,
		mappedPort,
		options.Events.LocalCandidate,
	)
	connection.OnICECandidate(receiver.localCandidates.addPion)
	connection.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		debug := slog.Default().Enabled(engine.ctx, slog.LevelDebug)
		if debug {
			slog.Debug("screener-client", "event", "media-connection-state", "direction", "inbound", "state", state.String())
		}
		var selected *SelectedPair
		if state == webrtc.PeerConnectionStateConnected && (receiver.events.ConnectionState != nil || debug) {
			if pair, pairErr := receiver.SelectedPair(); pairErr == nil {
				selected = &pair
				if debug {
					slog.Debug("screener-client", "event", "media-selected-path", "direction", "inbound",
						"localType", pair.Local.String(), "remoteType", pair.Remote.String(), "natTraversalPath", pair.NatTraversalPath)
				}
			}
		}
		if receiver.events.ConnectionState != nil {
			receiver.events.ConnectionState(state, selected)
		}
	})
	connection.OnTrack(func(track *webrtc.TrackRemote, rtpReceiver *webrtc.RTPReceiver) {
		go receiver.readRTCP(track, rtpReceiver)
		receiver.consumeTrack(track, rtpReceiver)
	})
	answer, err := receiver.createAnswer()
	if err != nil {
		_ = receiver.Close()
		return nil, webrtc.SessionDescription{}, err
	}
	return receiver, answer, nil
}

func (receiver *Receiver) Source() *Source           { return receiver.source }
func (receiver *Receiver) AudioSource() *AudioSource { return receiver.audioSource }
func (receiver *Receiver) HasAudio() bool            { return receiver.audioSource != nil }
func (receiver *Receiver) Codec() string             { return receiver.source.Codec() }

func (receiver *Receiver) createAnswer() (webrtc.SessionDescription, error) {
	receiver.mu.Lock()
	if receiver.closed {
		receiver.mu.Unlock()
		return webrtc.SessionDescription{}, errors.New("native media receiver is closed")
	}
	receiver.mu.Unlock()
	answer, err := receiver.connection.CreateAnswer(nil)
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	if err = receiver.connection.SetLocalDescription(answer); err != nil {
		return webrtc.SessionDescription{}, err
	}
	receiver.localCandidates.start()
	if receiver.connection.LocalDescription() == nil {
		return webrtc.SessionDescription{}, errors.New("native media receiver produced no SDP answer")
	}
	return *receiver.connection.LocalDescription(), nil
}

func (receiver *Receiver) AddRemoteCandidate(candidate *webrtc.ICECandidateInit) error {
	if malformedRemoteCandidate(candidate) {
		return nil
	}
	value := webrtc.ICECandidateInit{}
	if candidate != nil {
		value = *candidate
	}
	receiver.mu.Lock()
	if receiver.closed {
		receiver.mu.Unlock()
		return nil
	}
	receiver.mu.Unlock()
	_ = receiver.connection.AddICECandidate(value)
	return nil
}

func (receiver *Receiver) SelectedPair() (SelectedPair, error) {
	for _, transceiver := range receiver.connection.GetTransceivers() {
		inbound := transceiver.Receiver()
		if inbound == nil || inbound.Transport() == nil || inbound.Transport().ICETransport() == nil {
			continue
		}
		pair, err := inbound.Transport().ICETransport().GetSelectedCandidatePair()
		if err == nil && pair != nil {
			return SelectedPair{
				Local: pair.Local.Typ, Remote: pair.Remote.Typ,
				NatTraversalPath: selectedNatTraversalPath(
					pair.Local.Foundation,
					pair.Remote.Foundation,
				),
			}, nil
		}
	}
	return SelectedPair{}, errors.New("native media receiver ICE pair is unavailable")
}

func (receiver *Receiver) RequestKeyFrame() {
	receiver.mu.Lock()
	ssrc := receiver.videoSSRC
	closed := receiver.closed
	receiver.mu.Unlock()
	if closed || ssrc == 0 {
		return
	}
	_ = receiver.connection.WriteRTCP([]rtcp.Packet{
		&rtcp.PictureLossIndication{MediaSSRC: uint32(ssrc)},
	})
}

func (receiver *Receiver) Close() error {
	receiver.mu.Lock()
	if receiver.closed {
		receiver.mu.Unlock()
		return nil
	}
	receiver.closed = true
	localCandidates := receiver.localCandidates
	receiver.mu.Unlock()
	if localCandidates != nil {
		localCandidates.close()
	}
	_ = receiver.source.Close()
	if receiver.audioSource != nil {
		_ = receiver.audioSource.Close()
	}
	return receiver.connection.Close()
}

func (receiver *Receiver) consumeTrack(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
	if track == nil {
		return
	}
	if track.Kind() == webrtc.RTPCodecTypeVideo {
		if !strings.EqualFold(track.Codec().MimeType, videoCodecs[receiver.source.codec].MimeType) {
			return
		}
		receiver.mu.Lock()
		receiver.videoSSRC = track.SSRC()
		receiver.mu.Unlock()
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				if !errors.Is(err, io.EOF) {
					return
				}
				return
			}
			// Pion completes all bindings; each edge owns its write failure.
			_ = receiver.source.WriteRTP(packet)
		}
	}
	if track.Kind() == webrtc.RTPCodecTypeAudio && receiver.audioSource != nil &&
		strings.EqualFold(track.Codec().MimeType, webrtc.MimeTypeOpus) {
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			_ = receiver.audioSource.WriteRTP(packet)
		}
	}
}

func (receiver *Receiver) readRTCP(track *webrtc.TrackRemote, rtpReceiver *webrtc.RTPReceiver) {
	if rtpReceiver == nil {
		return
	}
	for {
		packets, _, err := rtpReceiver.ReadRTCP()
		if err != nil {
			return
		}
		if track.Kind() == webrtc.RTPCodecTypeVideo {
			for _, packet := range packets {
				if report, ok := packet.(*rtcp.SenderReport); ok && report.SSRC == uint32(track.SSRC()) {
					_ = receiver.source.SenderReport(report)
				}
			}
		}
	}
}

func offerSendsCodec(raw, kind, codecName string) (bool, error) {
	var description sdp.SessionDescription
	if err := description.UnmarshalString(raw); err != nil {
		return false, errors.New("native media receiver SDP is invalid")
	}
	for _, media := range description.MediaDescriptions {
		if media.MediaName.Media != kind || media.MediaName.Port.Value == 0 {
			continue
		}
		if _, inactive := media.Attribute("inactive"); inactive {
			continue
		}
		if _, receiveOnly := media.Attribute("recvonly"); receiveOnly {
			continue
		}
		for _, attribute := range media.Attributes {
			if attribute.Key != "rtpmap" {
				continue
			}
			fields := strings.Fields(attribute.Value)
			if len(fields) < 2 || !containsString(media.MediaName.Formats, fields[0]) {
				continue
			}
			if strings.HasPrefix(strings.ToLower(fields[1]), codecName+"/") {
				return true, nil
			}
		}
	}
	return false, nil
}

func selectReceiverVideoCodec(connection *webrtc.PeerConnection) (string, error) {
	for _, transceiver := range connection.GetTransceivers() {
		if transceiver.Kind() != webrtc.RTPCodecTypeVideo || transceiver.Receiver() == nil ||
			(transceiver.Direction() != webrtc.RTPTransceiverDirectionRecvonly &&
				transceiver.Direction() != webrtc.RTPTransceiverDirectionSendrecv) {
			continue
		}
		// Pion has already matched the remote codecs and FMTP, preserving offer order.
		for _, parameters := range transceiver.Receiver().GetParameters().Codecs {
			name := strings.TrimPrefix(strings.ToLower(parameters.MimeType), "video/")
			if _, supported := videoCodecs[name]; !supported {
				continue
			}
			if err := transceiver.SetCodecPreferences([]webrtc.RTPCodecParameters{parameters}); err != nil {
				return "", err
			}
			return name, nil
		}
	}
	return "", errors.New("native media receiver offer has no supported video")
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
