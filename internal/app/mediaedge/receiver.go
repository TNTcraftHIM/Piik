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
	// The final consumer must check current again after any event queues.
	LocalCandidate  func(candidate *webrtc.ICECandidateInit, current func() bool)
	ConnectionState func(state webrtc.PeerConnectionState, pair *SelectedPair, current func() bool)
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
	engine          *Engine
	connection      *webrtc.PeerConnection
	source          *Source
	audioSource     *AudioSource
	events          ReceiverEvents
	localCandidates *localCandidateGathering
	iceServers      []webrtc.ICEServer
	prepareMapping  func() int
	offerMu         sync.Mutex
	candidateMu     sync.Mutex

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
	var prepareMapping func() int
	if engine.portMapping != nil {
		prepareMapping = engine.portMapping.Prepare
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
		engine:         engine,
		connection:     connection,
		events:         options.Events,
		iceServers:     options.ICEServers,
		prepareMapping: prepareMapping,
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
	// Pion announces gathering before emitting candidates, including when a
	// remote ICE restart starts inside SetRemoteDescription. Ordinary SDP
	// renegotiation leaves this collector and its completion fence alone.
	connection.OnICEGatheringStateChange(func(state webrtc.ICEGatheringState) {
		if state == webrtc.ICEGatheringStateGathering {
			receiver.beginGathering()
		}
	})
	connection.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if !receiver.active() {
			return
		}
		debug := slog.Default().Enabled(engine.ctx, slog.LevelDebug)
		if debug {
			slog.Debug("piik-client", "event", "media-connection-state", "direction", "inbound", "state", state.String())
		}
		var selected *SelectedPair
		if state == webrtc.PeerConnectionStateConnected && (receiver.events.ConnectionState != nil || debug) {
			if pair, pairErr := receiver.SelectedPair(); pairErr == nil {
				selected = &pair
				if debug {
					slog.Debug("piik-client", "event", "media-selected-path", "direction", "inbound",
						"localType", pair.Local.String(), "remoteType", pair.Remote.String(), "natTraversalPath", pair.NatTraversalPath)
				}
			}
		}
		if receiver.events.ConnectionState != nil {
			receiver.events.ConnectionState(state, selected, receiver.active)
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

func (receiver *Receiver) active() bool {
	receiver.mu.Lock()
	defer receiver.mu.Unlock()
	return !receiver.closed
}

// Renegotiate keeps the encoded source and its consumers when the offer still
// describes the same media shape. A changed codec/audio shape needs replacement.
func (receiver *Receiver) Renegotiate(offer webrtc.SessionDescription, servers []webrtc.ICEServer) (webrtc.SessionDescription, bool, error) {
	receiver.offerMu.Lock()
	defer receiver.offerMu.Unlock()
	if offer.Type != webrtc.SDPTypeOffer || offer.SDP == "" {
		return webrtc.SessionDescription{}, false, errors.New("native media receiver input is invalid")
	}
	hasAudio, err := offerSendsCodec(offer.SDP, "audio", "opus")
	if err != nil {
		return webrtc.SessionDescription{}, false, err
	}
	sameVideo, err := offerSendsCodec(offer.SDP, "video", receiver.Codec())
	if err != nil || !sameVideo || hasAudio != receiver.HasAudio() {
		return webrtc.SessionDescription{}, false, err
	}
	receiver.mu.Lock()
	closed := receiver.closed
	receiver.iceServers = servers
	receiver.mu.Unlock()
	if closed {
		return webrtc.SessionDescription{}, false, errors.New("native media receiver is closed")
	}
	if err = receiver.connection.SetRemoteDescription(offer); err != nil {
		return webrtc.SessionDescription{}, false, err
	}
	answer, err := receiver.createAnswer()
	return answer, err == nil, err
}

func (receiver *Receiver) beginGathering() {
	// Serialize candidate delivery with collector replacement, without holding
	// the receiver state lock across the caller's event delivery.
	receiver.candidateMu.Lock()
	defer receiver.candidateMu.Unlock()
	receiver.mu.Lock()
	if receiver.closed {
		receiver.mu.Unlock()
		return
	}
	previous := receiver.localCandidates
	var gathering *localCandidateGathering
	current := func() bool {
		receiver.mu.Lock()
		defer receiver.mu.Unlock()
		return !receiver.closed && receiver.localCandidates == gathering
	}
	gathering = newLocalCandidateGathering(receiver.engine, receiver.iceServers, receiver.prepareMapping,
		func(candidate *webrtc.ICECandidateInit) {
			receiver.candidateMu.Lock()
			defer receiver.candidateMu.Unlock()
			if current() && receiver.events.LocalCandidate != nil {
				receiver.events.LocalCandidate(candidate, current)
			}
		})
	receiver.localCandidates = gathering
	receiver.mu.Unlock()
	if previous != nil {
		previous.close()
	}
	receiver.connection.OnICECandidate(gathering.addPion)
	gathering.start()
}

func (receiver *Receiver) createAnswer() (webrtc.SessionDescription, error) {
	receiver.mu.Lock()
	if receiver.closed {
		receiver.mu.Unlock()
		return webrtc.SessionDescription{}, errors.New("native media receiver is closed")
	}
	receiver.mu.Unlock()
	// Opus stereo is a local receive preference, not a property inherited from
	// the offer. Apply it on every answer, including same-source renegotiation.
	for _, transceiver := range receiver.connection.GetTransceivers() {
		if transceiver.Kind() != webrtc.RTPCodecTypeAudio || transceiver.Receiver() == nil ||
			(transceiver.Direction() != webrtc.RTPTransceiverDirectionRecvonly &&
				transceiver.Direction() != webrtc.RTPTransceiverDirectionSendrecv) {
			continue
		}
		for _, codec := range transceiver.Receiver().GetParameters().Codecs {
			if !strings.EqualFold(codec.MimeType, webrtc.MimeTypeOpus) {
				continue
			}
			codec.SDPFmtpLine = opusSDPFmtpLine + ";stereo=1;maxaveragebitrate=192000"
			if err := transceiver.SetCodecPreferences([]webrtc.RTPCodecParameters{codec}); err != nil {
				return webrtc.SessionDescription{}, err
			}
			break
		}
	}
	answer, err := receiver.connection.CreateAnswer(nil)
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	if err = receiver.connection.SetLocalDescription(answer); err != nil {
		return webrtc.SessionDescription{}, err
	}
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
