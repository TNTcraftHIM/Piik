package forwarding

import (
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
)

func TestSenderReportKeepsPrimaryClockDuringRTXProbes(t *testing.T) {
	registry := &interceptor.Registry{}
	if err := configureRTCPReports(registry); err != nil {
		t.Fatal(err)
	}
	chain, err := registry.Build("forwarding-reports")
	if err != nil {
		t.Fatal(err)
	}
	defer chain.Close()
	const primarySSRC, repairSSRC, timestamp = 1000, 2000, 2_600_000_000
	info := &interceptor.StreamInfo{SSRC: primarySSRC, SSRCRetransmission: repairSSRC, ClockRate: 90_000}
	var written int
	writer := chain.BindLocalStream(info, interceptor.RTPWriterFunc(func(header *rtp.Header, payload []byte, _ interceptor.Attributes) (int, error) {
		written++
		return header.MarshalSize() + len(payload) + int(header.PaddingSize), nil
	}))
	defer chain.UnbindLocalStream(info)
	write := func(header rtp.Header, payload []byte) {
		t.Helper()
		if _, err := writer.Write(&header, payload, nil); err != nil {
			t.Fatal(err)
		}
	}
	write(rtp.Header{Version: 2, SSRC: primarySSRC, SequenceNumber: 100, Timestamp: timestamp}, []byte{1, 2, 3})
	// LiveKit sends both repair and zero-timestamp RTX padding through the
	// primary writer. Their independent sequence/clock cannot seed its SR.
	write(rtp.Header{Version: 2, SSRC: repairSSRC, SequenceNumber: 101, Timestamp: timestamp - 9000}, []byte{0, 100, 1, 2, 3})
	write(rtp.Header{Version: 2, SSRC: repairSSRC, SequenceNumber: 102, Timestamp: 0, Padding: true, PaddingSize: 255}, nil)
	reports := make(chan *rtcp.SenderReport, 1)
	chain.BindRTCPWriter(interceptor.RTCPWriterFunc(func(packets []rtcp.Packet, _ interceptor.Attributes) (int, error) {
		for _, packet := range packets {
			if report, ok := packet.(*rtcp.SenderReport); ok && report.SSRC == primarySSRC {
				select {
				case reports <- report:
				default:
				}
			}
		}
		return len(packets), nil
	}))
	select {
	case report := <-reports:
		if delta := int32(report.RTPTime - timestamp); delta < 0 || delta > 3*90_000 || report.PacketCount != 1 || report.OctetCount != 3 {
			t.Fatalf("repair packets polluted primary sender report: %+v", report)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("primary sender report did not arrive")
	}
	if written != 3 {
		t.Fatalf("report isolation discarded media or repair packets: %d", written)
	}
}
