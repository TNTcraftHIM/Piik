package signal

import (
	"context"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/media/forwarding"
	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
	"github.com/TNTcraftHIM/Piik/internal/server/route"
	"github.com/TNTcraftHIM/Piik/internal/server/sfu"
	"github.com/pion/webrtc/v4"
)

func TestRoomSfuVideoAttachmentUsesExistingAdmissionAndExactPhysicalIdentity(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1, withSfu: true})
	created := h.createRoom()
	host, first, second := h.establishSfuRoom(created)
	h.settle()
	h.locked(func() {
		rm, _ := h.router.rooms.Get(created.RoomID)
		rm.roomMedia, rm.mediaGeneration = true, "room_media_12345678"
		rm.controller.SetVideoPublication(testShareGeneration, false, h.router.now())
		publication := rm.controller.Publication()
		originalHostID := publication.ConnectionID
		rm.controller.SetVideoPublication("", false, h.router.now())
		rm.controller.SetVideoPublication("video_next_12345678", false, h.router.now())
		rm.controller.SetHostVideoConnectionID("publisher_next_12345678")
		op := rm.controller.Reconcile(h.router.now()).Operation
		if op == nil || op.Reason != route.DemandPublicationAttach {
			t.Fatal("expected publication attachment")
		}
		child, other := first, second
		if op.ChildPeerID == second.peerID {
			child, other = second, first
		}
		edge, _ := rm.controller.Snapshot().UpstreamByViewer.Get(child.peerID)
		begun := rm.controller.BeginCurrentCandidate(route.BeginInput{
			Guard: cursorGuard(op, op.Candidates[op.Cursor]), NowMs: h.router.now(),
			ConnectionID: "subscriber_next_12345678",
		})
		if !begun.Accepted {
			t.Fatal("attachment did not begin")
		}
		op = begun.Operation
		message := protocol.SfuSignalMessage{Type: "sfu-signal", Kind: "candidate",
			Revision: protocol.Int(op.Current.Revision), PublicationGeneration: publication.Generation,
			ConnectionID: op.Current.ConnectionID}
		fence, allowed := h.router.sfuSignalAuthorized(child, message)
		if !allowed || fence.ConnectionID != edge.ConnectionID || fence.ResourceFence != resourceFence(publication.Resource) {
			t.Fatal("physical video attachment did not retain the exact logical reservation")
		}
		if _, allowed := h.router.sfuSignalAuthorized(other, message); allowed {
			t.Fatal("another viewer could use the admitted video facet")
		}
		stale := child
		stale.sessionID = "replaced_session_12345678"
		if _, allowed := h.router.sfuSignalAuthorized(stale, message); allowed {
			t.Fatal("stale session could signal an attachment")
		}
		voiceOnly := message
		voiceOnly.ConnectionID = edge.ConnectionID
		if _, allowed := h.router.sfuSignalAuthorized(child, voiceOnly); allowed {
			t.Fatal("room connection identity was accepted as the replacement video identity")
		}
		hostMessage := message
		hostMessage.ConnectionID = "publisher_next_12345678"
		if _, allowed := h.router.sfuSignalAuthorized(host, hostMessage); !allowed {
			t.Fatal("replacement publisher was rejected")
		}
		phase, revision := sfuConnectionPhase(rm.controller.Snapshot(), host.role, host.peerID,
			publication.Generation, hostMessage.ConnectionID)
		if phase != "prepare" || revision != op.Current.Revision {
			t.Fatal("publisher attachment lost its current operation phase")
		}
		h.router.prepareSfuVideoAttachment(created.RoomID, op)
		h.router.sendFreshSfuConfig(child)
		config, ok := h.sent[child.sessionID][len(h.sent[child.sessionID])-1].(protocol.SfuConfigMessage)
		if !ok || config.ConnectionID != message.ConnectionID || config.Revision != message.Revision {
			t.Fatal("reauthentication did not describe the pending physical attachment")
		}
		guard := route.CandidateGuard{ChildPeerID: child.peerID, ChildSessionID: child.sessionID,
			Revision: op.Current.Revision, ConnectionID: op.Current.ConnectionID}
		if !rm.controller.CandidateReady(guard, h.router.now(), nil,
			route.CandidateProof{VideoGeneration: "video_next_12345678"}).Committed {
			t.Fatal("video proof did not commit")
		}
		message.Revision = protocol.Int(rm.controller.Revision())
		if _, allowed := h.router.sfuSignalAuthorized(child, message); !allowed {
			t.Fatal("committed video facet was rejected")
		}
		h.router.handleSfuMediaEvent(sfu.MediaEvent{Fence: resourceFence(publication.Resource),
			ConnectionID: originalHostID, State: webrtc.PeerConnectionStateFailed})
		if current := rm.controller.Publication(); !current.Usable || current.ConnectionID != hostMessage.ConnectionID {
			t.Fatal("retired publisher callback invalidated its replacement")
		}
		rm.controller.SetVideoPublication("", false, h.router.now())
		if _, allowed := h.router.sfuSignalAuthorized(child, message); allowed {
			t.Fatal("stopped video retained signaling authority")
		}
		if !h.admission.HasSubscription(fence) || !h.admission.HasPublication(fence.ResourceFence) {
			t.Fatal("video stop released room admission")
		}
	})
}

func TestRoomSfuVideoRetirementDetachesBeforeCloseAndKeepsAdmission(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1, withSfu: true})
	created := h.createRoom()
	h.establishSfuRoom(created)
	h.settle()
	media := sfu.NewMedia(sfu.MediaOptions{})
	defer media.Close()
	h.locked(func() {
		rm, _ := h.router.rooms.Get(created.RoomID)
		rm.roomMedia, rm.mediaGeneration = true, "room_media_12345678"
		rm.controller.SetVideoPublication(testShareGeneration, false, h.router.now())
		publication := rm.controller.Publication()
		fence := resourceFence(publication.Resource)
		metadata := sfu.PublicationMedia{Codec: "vp8", RIDs: []string{""},
			Formats: []forwarding.LayerFormat{{Width: 640, Height: 360, Bitrate: 500_000}}}
		if err := media.PreparePublication(fence, publication.ConnectionID, metadata); err != nil {
			t.Fatal(err)
		}
		h.router.sfu.media = media
		h.router.retireRoomVideo(created.RoomID, rm)
		if media.HasPublication(fence, publication.ConnectionID) {
			t.Fatal("retired video remained visible while physical close was pending")
		}
		if !h.admission.HasPublication(fence) {
			t.Fatal("video retirement released room ingress")
		}
		if err := media.PreparePublication(fence, "replacement_publisher_12345678", metadata); err != nil {
			t.Fatal(err)
		}
		if retired := media.RetirePublication(fence, publication.ConnectionID); retired != nil {
			t.Fatal("old identity detached the replacement")
		}
	})
	h.settle()
	h.locked(func() {
		rm, _ := h.router.rooms.Get(created.RoomID)
		fence := resourceFence(rm.controller.Publication().Resource)
		if !media.HasPublication(fence, "replacement_publisher_12345678") {
			t.Fatal("old physical close removed the replacement")
		}
		if h.router.sfuDrainTasks.Len() != 0 {
			t.Fatal("retired physical close did not settle")
		}
	})
}

func TestSfuLogicalSubscriptionDrainClosesPendingPhysicalVideo(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	demand := make(chan struct{}, 1)
	media := sfu.NewMedia(sfu.MediaOptions{Events: func(event sfu.MediaEvent) {
		if event.ActiveCount != nil {
			select {
			case demand <- struct{}{}:
			default:
			}
		}
	}})
	defer media.Close()
	fence := sfu.SubscriptionFence{ResourceFence: sfu.ResourceFence{RoomID: "1234",
		ShareGeneration: "room_media_12345678", PublicationGeneration: "publication_12345678"},
		ViewerPeerID: "viewer_12345678", ConnectionID: "logical_edge_12345678"}
	if err := media.PreparePublication(fence.ResourceFence, "publisher_12345678", sfu.PublicationMedia{
		Codec: "vp8", RIDs: []string{""}, Formats: []forwarding.LayerFormat{{Width: 640, Height: 360, Bitrate: 500_000}},
	}); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := media.PrepareSubscriber(ctx, fence, "physical_video_12345678")
		result <- err
	}()
	select {
	case <-demand:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := media.CloseSubscription(fence, fence.ConnectionID); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("retired waiting subscriber was prepared")
		}
	case <-ctx.Done():
		t.Fatal("logical drain did not cancel physical video preparation")
	}
}
