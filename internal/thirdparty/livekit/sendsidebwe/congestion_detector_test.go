// Copyright 2026 LiveKit, Inc.
// Adapted from LiveKit v1.13.9 to use Go's standard testing package.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package sendsidebwe

import (
	"testing"

	"github.com/pion/interceptor/pkg/twcc"
	"github.com/pion/rtcp"

	"github.com/livekit/protocol/logger"
	"github.com/livekit/protocol/utils/mono"

	"github.com/livekit/livekit-server/pkg/sfu/ccutils"
)

func TestHandleTWCCFeedbackOverlappingReports(t *testing.T) {
	c := newCongestionDetector(congestionDetectorParams{
		Config: defaultCongestionDetectorConfig,
		Logger: logger.GetLogger(),
	})
	c.createCTRTrend()
	c.ProbeClusterStarting(ccutils.ProbeClusterInfo{Id: 1})
	// Keep the send-time baseline outside the reported sequence.
	c.RecordPacketSendAndGetSequenceNumber(1_000_000, 1200, false, 1, false)
	var sns [5]uint16
	for i := range sns {
		sns[i] = c.RecordPacketSendAndGetSequenceNumber(1_010_000+int64(i)*10_000, 1200, false, 1, false)
	}
	recorder := twcc.NewRecorder(1)
	var initial *rtcp.TransportLayerCC
	report := func() {
		t.Helper()
		for _, packet := range recorder.BuildFeedbackPacket() {
			feedback := packet.(*rtcp.TransportLayerCC)
			if initial == nil {
				initial = feedback
			}
			c.HandleTWCCFeedback(feedback)
		}
	}
	check := func(acked, lost int) {
		t.Helper()
		for name, group := range map[string]*packetGroup{
			"normal": c.packetGroups[0], "probe": c.probePacketGroup.packetGroup, "congested": c.congestedPacketGroup,
		} {
			if group.acked.numPackets() != acked || group.lost.numPackets() != lost ||
				group.acked.numBytes() != acked*1200 || group.lost.numBytes() != lost*1200 {
				t.Fatalf("%s feedback: ack=%+v lost=%+v, want %d/%d packets", name, group.acked, group.lost, acked, lost)
			}
		}
	}
	// Pion repeats earlier received/lost packets when a late packet arrives.
	recorder.Record(1, sns[0], 1_000_000)
	recorder.Record(1, sns[3], 1_030_000)
	report()
	check(2, 2)
	recorder.Record(1, sns[1], 1_040_000)
	report()
	check(3, 1)
	recorder.Record(1, sns[2], 1_050_000)
	report()
	check(4, 0)
	lastReceived := *c.packetTracker.piLastRecv
	c.HandleTWCCFeedback(initial)
	check(4, 0)
	if *c.packetTracker.piLastRecv != lastReceived {
		t.Fatal("repeated feedback changed the receive-time baseline")
	}
	recorder.Record(1, sns[4], 1_060_000)
	report()
	check(5, 0)
	if got := c.packetTracker.getPacketInfoExisting(sns[4]).recvTime; got != 60_000 {
		t.Fatalf("receive time after overlapping feedback = %d, want 60000", got)
	}
}

// the reserved symbol has no receive delta, so its packet is neither acked nor lost,
// and the next received packet uses the next delta
func TestHandleTWCCFeedbackReservedSymbol(t *testing.T) {
	// small delta, reserved, reserved, small delta, not received
	for name, chunks := range map[string][]rtcp.PacketStatusChunk{
		"status vector": {
			&rtcp.StatusVectorChunk{
				SymbolSize: rtcp.TypeTCCSymbolSizeTwoBit,
				SymbolList: []uint16{
					rtcp.TypeTCCPacketReceivedSmallDelta,
					rtcp.TypeTCCPacketReceivedWithoutDelta,
					rtcp.TypeTCCPacketReceivedWithoutDelta,
					rtcp.TypeTCCPacketReceivedSmallDelta,
					rtcp.TypeTCCPacketNotReceived,
					rtcp.TypeTCCPacketNotReceived,
					rtcp.TypeTCCPacketNotReceived,
				},
			},
		},
		"run length": {
			&rtcp.RunLengthChunk{PacketStatusSymbol: rtcp.TypeTCCPacketReceivedSmallDelta, RunLength: 1},
			&rtcp.RunLengthChunk{PacketStatusSymbol: rtcp.TypeTCCPacketReceivedWithoutDelta, RunLength: 2},
			&rtcp.RunLengthChunk{PacketStatusSymbol: rtcp.TypeTCCPacketReceivedSmallDelta, RunLength: 1},
			&rtcp.RunLengthChunk{PacketStatusSymbol: rtcp.TypeTCCPacketNotReceived, RunLength: 1},
		},
	} {
		t.Run(name, func(t *testing.T) {
			c := newCongestionDetector(congestionDetectorParams{
				Config: defaultCongestionDetectorConfig,
				Logger: logger.GetLogger(),
			})
			// the first packet sent is the send time base and never joins a group, so keep it out of the report
			now := mono.UnixMicro()
			c.RecordPacketSendAndGetSequenceNumber(now, 1200, false, ccutils.ProbeClusterIdInvalid, false)
			sns := make([]uint16, 5)
			for i := range sns {
				sns[i] = c.RecordPacketSendAndGetSequenceNumber(now+int64(i+1)*1000, 1200, false, ccutils.ProbeClusterIdInvalid, false)
			}

			fb := &rtcp.TransportLayerCC{
				Header: rtcp.Header{
					Count: rtcp.FormatTCC,
					Type:  rtcp.TypeTransportSpecificFeedback,
				},
				MediaSSRC:          1,
				BaseSequenceNumber: sns[0],
				PacketStatusCount:  uint16(len(sns)),
				ReferenceTime:      100,
				FbPktCount:         1,
				PacketChunks:       chunks,
				RecvDeltas: []*rtcp.RecvDelta{
					{Type: rtcp.TypeTCCPacketReceivedSmallDelta, Delta: 1000},
					{Type: rtcp.TypeTCCPacketReceivedSmallDelta, Delta: 2000},
				},
			}
			fb.Header.Padding = fb.MarshalSize()%4 != 0
			fb.Header.Length = uint16(fb.MarshalSize()/4 - 1)

			// round trip so the report is exactly what a remote peer can deliver
			raw, err := fb.Marshal()
			if err != nil {
				t.Fatal(err)
			}
			pkts, err := rtcp.Unmarshal(raw)
			if err != nil {
				t.Fatal(err)
			}

			c.HandleTWCCFeedback(pkts[0].(*rtcp.TransportLayerCC))

			// receive time is relative to the first received packet
			if got := c.packetTracker.getPacketInfoExisting(sns[3]).recvTime; got != 2000 {
				t.Fatalf("receive time after reserved symbols = %d, want 2000", got)
			}

			acked, lost := 0, 0
			for _, pg := range c.packetGroups {
				acked += pg.acked.numPackets()
				lost += pg.lost.numPackets()
			}
			if acked != 2 || lost != 1 {
				t.Fatalf("feedback counts: acked=%d lost=%d, want 2 and 1", acked, lost)
			}
		})
	}
}

// A feedback packet that closes the previous group still belongs to the next
// measurement. Losing it biases throughput and loss, especially on sparse video.
func TestCongestedTrafficAcrossGroupBoundaries(t *testing.T) {
	for _, lostBoundary := range []bool{false, true} {
		config := defaultCongestionDetectorConfig
		config.CongestedPacketGroup.MinPackets = 2
		c := newCongestionDetector(congestionDetectorParams{Config: config, Logger: logger.GetLogger()})
		c.createCTRTrend()
		lastReceived := int64(90_000)
		for i := range 6 {
			lost := lostBoundary && i == 2
			packet := packetInfo{sequenceNumber: uint64(i + 1), sendTime: 100_000 + int64(i)*10_000, size: uint16(100 * (i + 1))}
			delta := int64(0)
			if !lost {
				packet.recvTime = packet.sendTime + 300_000
				delta = packet.sendTime - lastReceived
				lastReceived = packet.sendTime
			}
			c.updateCTRTrend(&packet, delta, delta, lost)
		}
		total := newTrafficStats(trafficStatsParams{Config: config.WeightedLoss})
		total.Merge(c.congestedTrafficStats)
		total.Merge(c.congestedPacketGroup.Traffic())
		ackedPackets, ackedBytes, lostPackets, lostBytes := 6, 2100, 0, 0
		if lostBoundary {
			ackedPackets, ackedBytes, lostPackets, lostBytes = 5, 1800, 1, 300
		}
		if total.ackedPackets != ackedPackets || total.ackedBytes != ackedBytes ||
			total.lostPackets != lostPackets || total.lostBytes != lostBytes ||
			total.Duration() != 60_000 || total.sendDelta != 60_000 || total.recvDelta != 60_000 {
			t.Fatalf("lost boundary=%v: feedback was not conserved: %+v", lostBoundary, total)
		}
	}
}
