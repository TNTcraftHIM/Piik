package mediaedge

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestLocalRestartRetainsMediaAndRejectsStaleAnswers(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	engine, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
	check(err)
	t.Cleanup(func() { _ = engine.Close() })
	source, err := engine.NewSource("vp8", 1, 1, nil)
	check(err)
	t.Cleanup(func() { _ = source.Close() })
	edge, err := engine.NewEdge(source, EdgeOptions{ConnectionID: "local-preview", Local: true})
	check(err)
	t.Cleanup(func() { _ = edge.Close() })
	receiver := newReceiver(t)
	t.Cleanup(func() { _ = receiver.Close() })
	connection, transport, sender := edge.connection, edge.transport, edge.sender
	answer := func(offer webrtc.SessionDescription) webrtc.SessionDescription {
		t.Helper()
		check(receiver.SetRemoteDescription(offer))
		description, err := receiver.CreateAnswer(nil)
		check(err)
		gathered := webrtc.GatheringCompletePromise(receiver)
		check(receiver.SetLocalDescription(description))
		select {
		case <-gathered:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		return *receiver.LocalDescription()
	}
	ufrag := func(sdp string) string {
		for _, line := range strings.Split(sdp, "\r\n") {
			if strings.HasPrefix(line, "a=ice-ufrag:") {
				return line
			}
		}
		t.Fatal("missing ICE credentials")
		return ""
	}
	initial, err := edge.CreateLocalOffer(ctx, "local_offer_1", false)
	check(err)
	if !strings.Contains(initial.SDP, "a=candidate:") || edge.localCandidates != nil {
		t.Fatal("local bridge did not use complete SDP")
	}
	oldAnswer := answer(initial)
	check(edge.SetAnswer(oldAnswer, "local_offer_1"))
	check(edge.SetAnswer(oldAnswer, "local_offer_1")) // Same transaction is idempotent.
	for _, offerID := range []string{"local_offer_2", "local_offer_3"} {
		offer, err := edge.CreateLocalOffer(ctx, offerID, true)
		check(err)
		if ufrag(initial.SDP) == ufrag(offer.SDP) {
			t.Fatal("restart reused ICE credentials")
		}
		if err = edge.SetAnswer(oldAnswer, "local_offer_1"); err == nil {
			t.Fatal("stale answer was accepted into a newer negotiation")
		}
		if _, err = edge.CreateLocalOffer(ctx, "overlapping_offer", true); err == nil {
			t.Fatal("an unanswered negotiation was replaced")
		}
		check(edge.SetAnswer(answer(offer), offerID))
		if edge.connection != connection || edge.transport != transport || edge.sender != sender || edge.source != source {
			t.Fatal("ICE recovery replaced a media owner")
		}
		initial = offer
	}
	canceled, stop := context.WithCancel(ctx)
	stop()
	if _, err = edge.CreateLocalOffer(canceled, "canceled_offer", true); err == nil {
		t.Fatal("canceled operation changed negotiation")
	}
	if edge.localOfferID != "local_offer_3" {
		t.Fatal("canceled operation replaced offer identity")
	}
	check(edge.Close())
	if _, err = edge.CreateLocalOffer(ctx, "retired_offer", true); err == nil {
		t.Fatal("restart reopened a retired edge")
	}
}
