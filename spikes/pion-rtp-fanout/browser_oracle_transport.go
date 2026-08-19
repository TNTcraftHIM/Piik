package fanoutoracle

import (
	"context"
	"fmt"
	"sync"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

var browserOracleInitialSequences = [2]uint16{1000, 30000}

type browserPeerLeg struct {
	id        int
	pc        *webrtc.PeerConnection
	track     *webrtc.TrackLocalStaticSample
	sender    *webrtc.RTPSender
	rtp       *rtpRecorder
	rtcp      *rtcpRecorder
	connected chan struct{}
	terminal  chan error
	once      sync.Once
	stateMu   sync.RWMutex
	state     webrtc.PeerConnectionState
	offer     webrtc.SessionDescription
	answer    webrtc.SessionDescription
}

func newBrowserPeerLeg(id int) (*browserPeerLeg, error) {
	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterDefaultCodecs(); err != nil {
		return nil, fmt.Errorf("register codecs: %w", err)
	}

	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(mediaEngine, registry); err != nil {
		return nil, fmt.Errorf("register interceptors: %w", err)
	}

	rtpMetrics := &rtpRecorder{}
	registry.Add(&rtpRecorderFactory{recorder: rtpMetrics})
	api := webrtc.NewAPI(
		webrtc.WithMediaEngine(mediaEngine),
		webrtc.WithInterceptorRegistry(registry),
	)
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, fmt.Errorf("create PeerConnection: %w", err)
	}

	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000},
		fmt.Sprintf("video-%d", id+1),
		fmt.Sprintf("browser-oracle-%d", id+1),
		webrtc.WithRTPSequenceNumber(browserOracleInitialSequences[id]),
		webrtc.WithRTPTimestamp(90000),
	)
	if err != nil {
		_ = pc.Close()
		return nil, fmt.Errorf("create VP8 sample track: %w", err)
	}

	sender, err := pc.AddTrack(track)
	if err != nil {
		_ = pc.Close()
		return nil, fmt.Errorf("add VP8 sample track: %w", err)
	}

	leg := &browserPeerLeg{
		id:        id,
		pc:        pc,
		track:     track,
		sender:    sender,
		rtp:       rtpMetrics,
		rtcp:      &rtcpRecorder{},
		connected: make(chan struct{}),
		terminal:  make(chan error, 1),
		state:     webrtc.PeerConnectionStateNew,
	}
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		leg.stateMu.Lock()
		leg.state = state
		leg.stateMu.Unlock()
		if state == webrtc.PeerConnectionStateConnected {
			leg.once.Do(func() { close(leg.connected) })
		}
		if state == webrtc.PeerConnectionStateFailed {
			select {
			case leg.terminal <- fmt.Errorf("peer %d entered failed state", id+1):
			default:
			}
		}
	})

	go leg.readRTCP()
	return leg, nil
}

func (leg *browserPeerLeg) createOffer(ctx context.Context) (webrtc.SessionDescription, error) {
	offer, err := leg.pc.CreateOffer(nil)
	if err != nil {
		return webrtc.SessionDescription{}, fmt.Errorf("create offer: %w", err)
	}
	gathering := webrtc.GatheringCompletePromise(leg.pc)
	if err = leg.pc.SetLocalDescription(offer); err != nil {
		return webrtc.SessionDescription{}, fmt.Errorf("set local offer: %w", err)
	}
	select {
	case <-gathering:
	case <-ctx.Done():
		return webrtc.SessionDescription{}, ctx.Err()
	}
	leg.offer = *leg.pc.LocalDescription()
	return leg.offer, nil
}

func (leg *browserPeerLeg) setAnswer(answer webrtc.SessionDescription) error {
	if err := leg.pc.SetRemoteDescription(answer); err != nil {
		return fmt.Errorf("set browser answer: %w", err)
	}
	leg.answer = answer
	return nil
}

func (leg *browserPeerLeg) waitConnected(ctx context.Context) error {
	select {
	case <-leg.connected:
		return nil
	case err := <-leg.terminal:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (leg *browserPeerLeg) connectionState() string {
	leg.stateMu.RLock()
	defer leg.stateMu.RUnlock()
	return leg.state.String()
}

func (leg *browserPeerLeg) readRTCP() {
	for {
		packets, _, err := leg.sender.ReadRTCP()
		if err != nil {
			return
		}
		leg.rtcp.record(packets)
	}
}

func (leg *browserPeerLeg) close() {
	_ = leg.pc.Close()
}

type rtpRecorder struct {
	mu       sync.RWMutex
	metrics  RTPMetrics
	observed bool
}

func (recorder *rtpRecorder) record(header *rtp.Header, payload []byte) {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	if !recorder.observed {
		recorder.metrics.SSRC = header.SSRC
		recorder.metrics.FirstSequence = header.SequenceNumber
		recorder.observed = true
	}
	recorder.metrics.LastSequence = header.SequenceNumber
	recorder.metrics.Packets++
	recorder.metrics.PayloadBytes += uint64(len(payload))
}

func (recorder *rtpRecorder) snapshot() RTPMetrics {
	recorder.mu.RLock()
	defer recorder.mu.RUnlock()
	return recorder.metrics
}

type rtpRecorderFactory struct {
	recorder *rtpRecorder
}

func (factory *rtpRecorderFactory) NewInterceptor(string) (interceptor.Interceptor, error) {
	return &rtpRecorderInterceptor{recorder: factory.recorder}, nil
}

type rtpRecorderInterceptor struct {
	interceptor.NoOp
	recorder *rtpRecorder
}

func (observer *rtpRecorderInterceptor) BindLocalStream(_ *interceptor.StreamInfo, writer interceptor.RTPWriter) interceptor.RTPWriter {
	return interceptor.RTPWriterFunc(func(header *rtp.Header, payload []byte, attributes interceptor.Attributes) (int, error) {
		observer.recorder.record(header, payload)
		return writer.Write(header, payload, attributes)
	})
}

type rtcpRecorder struct {
	mu      sync.RWMutex
	metrics RTCPMetrics
}

func (recorder *rtcpRecorder) record(packets []rtcp.Packet) {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	for _, packet := range packets {
		recorder.metrics.Packets++
		switch packet.(type) {
		case *rtcp.ReceiverReport:
			recorder.metrics.ReceiverReports++
		case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
			recorder.metrics.PictureLoss++
		case *rtcp.TransportLayerNack:
			recorder.metrics.NACK++
		}
	}
}

func (recorder *rtcpRecorder) snapshot() RTCPMetrics {
	recorder.mu.RLock()
	defer recorder.mu.RUnlock()
	return recorder.metrics
}
