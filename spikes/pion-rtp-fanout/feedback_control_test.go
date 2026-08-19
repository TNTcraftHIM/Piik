package fanoutoracle

import (
	"context"
	"testing"
	"time"

	"github.com/pion/rtcp"
)

func TestKeyFrameMergerCoalescesPLIAndFIR(t *testing.T) {
	now := time.Unix(0, 0)
	requests := 0
	merger := newKeyFrameMerger(func() time.Time { return now }, func() error {
		requests++
		return nil
	})

	if err := merger.HandleRTCP(0, []rtcp.Packet{&rtcp.PictureLossIndication{}}, 40*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	now = now.Add(5 * time.Millisecond)
	if err := merger.HandleRTCP(1, []rtcp.Packet{&rtcp.PictureLossIndication{}}, 40*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	fir := &rtcp.FullIntraRequest{SenderSSRC: 1, FIR: []rtcp.FIREntry{{SSRC: 2, SequenceNumber: 9}}}
	if err := merger.HandleRTCP(0, []rtcp.Packet{fir, fir}, 40*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if err := merger.HandleRTCP(1, []rtcp.Packet{fir}, 40*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("encoder requests = %d, want 1", requests)
	}
	if got := merger.Snapshot().FIREntriesByLeg; got != [feedbackLegCount]int{2, 1} {
		t.Fatalf("FIR entries by leg = %v, want [2 1]", got)
	}

	now = now.Add(15 * time.Millisecond)
	merger.ObserveKeyFrame()
	now = now.Add(50 * time.Millisecond)
	if err := merger.HandleRTCP(0, []rtcp.Packet{fir}, 40*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("same FIR before 2*RTT emitted request %d", requests)
	}
	now = now.Add(40 * time.Millisecond)
	if err := merger.HandleRTCP(0, []rtcp.Packet{fir}, 40*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if requests != 2 {
		t.Fatalf("same FIR after 2*RTT emitted requests = %d, want 2", requests)
	}
}

func TestKeyFrameMergerDoesNotDeduplicateFailedRequest(t *testing.T) {
	now := time.Unix(0, 0)
	attempts := 0
	merger := newKeyFrameMerger(func() time.Time { return now }, func() error {
		attempts++
		if attempts == 1 {
			return context.Canceled
		}
		return nil
	})
	fir := &rtcp.FullIntraRequest{SenderSSRC: 1, FIR: []rtcp.FIREntry{{SSRC: 2, SequenceNumber: 9}}}

	if err := merger.HandleRTCP(0, []rtcp.Packet{fir}, 40*time.Millisecond); err == nil {
		t.Fatal("first key-frame request succeeded, want callback error")
	}
	if err := merger.HandleRTCP(0, []rtcp.Packet{fir}, 40*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if attempts != 2 {
		t.Fatalf("key-frame request attempts = %d, want 2", attempts)
	}
}

func TestSharedBitrateWaitsForBothLegsAndSelectsMinimum(t *testing.T) {
	target, err := newSharedBitrateTarget(150_000, 600_000)
	if err != nil {
		t.Fatal(err)
	}
	if selected, changed, updateErr := target.Update(0, 900_000); updateErr != nil || selected != 0 || changed {
		t.Fatalf("first leg update = %d/%v/%v", selected, changed, updateErr)
	}
	if selected, changed, updateErr := target.Update(1, 450_000); updateErr != nil || selected != 450_000 || !changed {
		t.Fatalf("two-leg update = %d/%v/%v", selected, changed, updateErr)
	}
	if selected, changed, updateErr := target.Update(0, 100_000); updateErr != nil || selected != 150_000 || !changed {
		t.Fatalf("clamped weak-leg update = %d/%v/%v", selected, changed, updateErr)
	}
}

func TestNACKRTXTraceKeepsLegsAndCacheIndependent(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result, _, err := runNACKRTXTrace(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !result.IndependentLegs || !result.OldestPacketEvicted {
		t.Fatalf("NACK/RTX result = %+v", result)
	}
	if result.Legs[0].RetransmittedOriginalSeq != 10_000+feedbackNACKCachePackets {
		t.Fatalf("leg 1 RTX original sequence = %d", result.Legs[0].RetransmittedOriginalSeq)
	}
	if result.Legs[1].RetransmittedOriginalSeq != 30_000 {
		t.Fatalf("leg 2 RTX original sequence = %d", result.Legs[1].RetransmittedOriginalSeq)
	}
	if result.Legs[0].RTXPackets != 1 || result.Legs[1].RTXPackets != 1 {
		t.Fatalf("RTX packet counts = %d/%d, want 1/1", result.Legs[0].RTXPackets, result.Legs[1].RTXPackets)
	}
}

func TestFeedbackControlOracleRecordsStockGCCRTXNoGo(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result, err := RunFeedbackControlOracle(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.Verdict != "no-go-stock-pion-gcc-rtx" {
		t.Fatalf("verdict = %q", result.Verdict)
	}
	if result.StockGCCRTX.RTXDelivered || !result.StockGCCRTX.UnknownSSRC || result.StockGCCRTX.Error == "" {
		t.Fatalf("stock GCC RTX trace = %+v", result.StockGCCRTX)
	}
}

func TestPrimaryRetransmissionPassesStockGCCWithoutRTX(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result, err := runPrimaryRetransmissionTrace(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.RTXNegotiated || !result.PrimaryDelivered || !result.RetransmissionDelivered {
		t.Fatalf("delivery trace = %+v", result)
	}
	if !result.SameRTPIdentity || !result.DistinctTransportSequence {
		t.Fatalf("RTP/TWCC identity trace = %+v", result)
	}
	if result.Pacer != "gcc.NewNoOpPacer" || result.PacerQueue != "none" {
		t.Fatalf("pacer trace = %+v", result)
	}
}
