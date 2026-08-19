package fanoutoracle

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
)

func TestPrimaryRetransmissionWithRealChromium(t *testing.T) {
	if os.Getenv("SCREENER_RUN_PRIMARY_RETRANSMISSION") != "1" {
		t.Skip("set SCREENER_RUN_PRIMARY_RETRANSMISSION=1 to run the one-sided real-browser loss gate")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
	defer cancel()
	if _, err := RunPrimaryRetransmissionBrowserGate(ctx, LiveBridgeOptions{}); err != nil {
		t.Fatal(err)
	}
}

func TestPrimaryLossBoundaryDropsOnlyTargetAndRecognizesReplay(t *testing.T) {
	recorder := &rtpRecorder{}
	boundary := newPrimaryLossBoundary(2, recorder)
	factory := &primaryLossBoundaryFactory{boundary: boundary}
	interceptorInstance, err := factory.NewInterceptor("test")
	if err != nil {
		t.Fatal(err)
	}
	output := newTraceRTPWriter()
	info := interceptor.StreamInfo{
		SSRC:        7001,
		PayloadType: 96,
		RTPHeaderExtensions: []interceptor.RTPHeaderExtension{{
			URI: transportCCHeaderExtensionURI,
			ID:  3,
		}},
	}
	writer := interceptorInstance.BindLocalStream(&info, output)

	write := func(sequence, transportSequence uint16) {
		t.Helper()
		header := &rtp.Header{
			Version:        2,
			PayloadType:    96,
			SequenceNumber: sequence,
			Timestamp:      uint32(sequence) * 3000,
			SSRC:           info.SSRC,
			Marker:         true,
		}
		extension, marshalErr := (&rtp.TransportCCExtension{TransportSequence: transportSequence}).Marshal()
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		if setErr := header.SetExtension(3, extension); setErr != nil {
			t.Fatal(setErr)
		}
		if _, writeErr := writer.Write(header, []byte{byte(sequence)}, nil); writeErr != nil {
			t.Fatal(writeErr)
		}
	}

	write(100, 10)
	write(101, 11)
	write(102, 12)
	boundary.observeNACK(101)
	write(101, 13)
	write(103, 14)

	metrics := boundary.snapshot()
	if metrics.PrimaryAttempts != 4 || metrics.DroppedPackets != 1 || metrics.DeliveredPackets != 4 {
		t.Fatalf("packet boundary = %+v", metrics)
	}
	if metrics.TargetNACKRequests != 1 || metrics.Retransmissions != 1 || !metrics.RetransmissionSameIdentity {
		t.Fatalf("NACK/replay boundary = %+v", metrics)
	}
	if metrics.OriginalTransportSequence != 11 || metrics.RetransmitTransportSequence != 13 || !metrics.DistinctTransportSequence {
		t.Fatalf("TWCC boundary = %+v", metrics)
	}
	if metrics.OutstandingPackets != 0 || metrics.MaxOutstandingPackets != 1 || metrics.PacketsAfterRecovery != 1 {
		t.Fatalf("bounded recovery = %+v", metrics)
	}
}

func TestPrimaryLossBoundaryMarksOnlySuccessfulReplay(t *testing.T) {
	recorder := &rtpRecorder{}
	boundary := newPrimaryLossBoundary(1, recorder)
	interceptorInstance, err := (&primaryLossBoundaryFactory{boundary: boundary}).NewInterceptor("test")
	if err != nil {
		t.Fatal(err)
	}
	output := &failRTPSequenceOnceWriter{
		sequence: 501,
		next:     newTraceRTPWriter(),
	}
	info := interceptor.StreamInfo{SSRC: 7002, PayloadType: 96}
	writer := interceptorInstance.BindLocalStream(&info, output)
	header := &rtp.Header{
		Version:        2,
		PayloadType:    96,
		SequenceNumber: output.sequence,
		Timestamp:      12345,
		SSRC:           info.SSRC,
		Marker:         true,
	}
	payload := []byte{1, 2, 3}
	if _, err = writer.Write(header, payload, nil); err != nil {
		t.Fatal(err)
	}
	boundary.observeNACK(output.sequence)
	if _, err = writer.Write(header, payload, nil); err == nil {
		t.Fatal("first replay reached a failing downstream writer")
	}
	metrics := boundary.snapshot()
	if boundary.isRecovered() || metrics.Retransmissions != 0 || metrics.OutstandingPackets != 1 || metrics.DeliveredPackets != 0 {
		t.Fatalf("failed replay changed recovery state: %+v", metrics)
	}
	if _, err = writer.Write(header, payload, nil); err != nil {
		t.Fatal(err)
	}
	metrics = boundary.snapshot()
	if !boundary.isRecovered() || metrics.Retransmissions != 1 || metrics.OutstandingPackets != 0 || metrics.DeliveredPackets != 1 {
		t.Fatalf("successful replay did not close recovery: %+v", metrics)
	}
}

func TestPrimaryRetransmissionPeerOffersNACKWithoutRTX(t *testing.T) {
	leg, err := newBrowserPeerLegWithOptions(0, browserPeerLegOptions{
		primaryRetransmission: true,
		dropAttempt:           primaryRetransmissionDropAttempt,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer leg.close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	offer, err := leg.createOffer(ctx)
	if err != nil {
		t.Fatal(err)
	}
	capabilities, err := inspectControlSDP(offer.SDP)
	if err != nil {
		t.Fatal(err)
	}
	if capabilities.rtx || !capabilities.nack || !capabilities.twcc {
		t.Fatalf("offer capabilities = %+v", capabilities)
	}
	parameters := leg.sender.GetParameters()
	if len(parameters.Encodings) != 1 || parameters.Encodings[0].RTX.SSRC != 0 {
		t.Fatalf("sender encodings = %+v", parameters.Encodings)
	}
	if leg.estimator == nil || leg.estimator.GetTargetBitrate() != feedbackEncoderMaxBitrate {
		t.Fatal("stock GCC estimator was not attached at the configured bitrate")
	}
}

type failRTPSequenceOnceWriter struct {
	sequence uint16
	failed   bool
	next     interceptor.RTPWriter
}

func (writer *failRTPSequenceOnceWriter) Write(
	header *rtp.Header, payload []byte, attributes interceptor.Attributes,
) (int, error) {
	if header.SequenceNumber == writer.sequence && !writer.failed {
		writer.failed = true
		return 0, errors.New("injected RTP write failure")
	}
	return writer.next.Write(header, payload, attributes)
}
