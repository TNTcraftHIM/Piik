package signal

// Viewer presence, host status, disconnect handling and room termination of
// src/server/signaling.ts (sendViewerPresence 1594, broadcastHostStatus
// 1683, handleDisconnect 1397, stopSharing 1466, closeRoom,
// revokeGrantViewers 1016, closeRevokedViewerSession 1697 and the
// viewer-keyed map helpers). Every function here runs with mu held.

import (
	"fmt"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/TNTcraftHIM/Screener/internal/server/protocol"
	"github.com/TNTcraftHIM/Screener/internal/server/room"
)

// viewerKey is the TS `${roomId}:${peerId}` used by the grace timers and the
// viewer quality evidence maps (viewerGraceKey and viewerConnectionKey were
// the same expression).
func viewerKey(roomID, peerID string) string { return roomID + ":" + peerID }

// sendViewerPresence ports sendViewerPresence (O12): the host entry first
// when it has a display name, then viewers in store order; recipients are
// the opted-in host first, then opted-in viewers in store order, deduped by
// connection (hazard 11).
func (s *Server) sendViewerPresence(roomID string) {
	if _, deferred := s.deferredViewerPresenceRooms[roomID]; deferred {
		return
	}

	connectedViewers := s.store.GetConnectedViewers(roomID)
	viewers := []protocol.ParticipantPresenceEntry{}
	host, hasHost := s.store.GetConnectedHost(roomID)
	var hostSession *session
	var hostState *authenticatedSession
	if hasHost {
		hostSession = s.sessionsByID[host.SessionID]
		if hostSession != nil {
			hostState = hostSession.authenticated
		}
	}
	if hasHost && hostSession != nil && hostState != nil &&
		hostState.role == protocol.RoleHost &&
		hostState.roomID == roomID &&
		hostState.peerID == host.PeerID &&
		hostState.displayName != nil {
		viewers = append(viewers, protocol.HostPresenceEntry(host.PeerID, protocol.DisplayName(*hostState.displayName)))
	}

	for _, viewer := range connectedViewers {
		viewerState := s.authenticatedOf(viewer.SessionID)
		if viewerState == nil ||
			viewerState.role != protocol.RoleViewer ||
			viewerState.roomID != roomID ||
			viewerState.peerID != viewer.PeerID ||
			viewerState.displayName == nil {
			continue
		}
		upstream := s.router.getViewerRouteUpstream(roomID, viewer.PeerID)
		activeEdge, hasActiveEdge := s.router.resolveActiveViewerMediaEdge(roomID, viewer.PeerID)
		mediaReady := hasActiveEdge && upstream.Kind != "none"
		if mediaReady {
			if activeEdge.upstream.Kind == "sfu" {
				mediaReady = upstream.Kind == "sfu"
			} else {
				mediaReady = upstream.Kind == "peer" && activeEdge.upstream.PeerID == upstream.PeerID
			}
		}
		viewers = append(viewers, protocol.NewViewerPresenceEntry(
			viewer.PeerID, protocol.DisplayName(*viewerState.displayName), upstream, mediaReady))
	}
	encoded, err := protocol.EncodeServerMessage(protocol.ViewerPresenceMessage{
		Type:    "viewer-presence",
		Viewers: viewers,
	})
	if err != nil {
		panic(err)
	}

	var recipients []*session
	seen := map[*session]struct{}{}
	add := func(sess *session) {
		if _, duplicate := seen[sess]; duplicate {
			return
		}
		seen[sess] = struct{}{}
		recipients = append(recipients, sess)
	}
	if hostSession != nil && hostState != nil && hostState.viewerPresence {
		add(hostSession)
	}
	for _, viewer := range connectedViewers {
		viewerSession := s.sessionsByID[viewer.SessionID]
		if viewerSession == nil {
			continue
		}
		viewerState := viewerSession.authenticated
		if viewerState != nil &&
			viewerState.role == protocol.RoleViewer &&
			viewerState.roomID == roomID &&
			viewerState.peerID == viewer.PeerID &&
			viewerState.viewerPresence {
			add(viewerSession)
		}
	}
	for _, sess := range recipients {
		s.sendEncoded(sess, encoded)
	}
}

// broadcastHostStatus ports broadcastHostStatus (O10).
func (s *Server) broadcastHostStatus(roomID string, online, paused bool) {
	for _, viewer := range s.store.GetConnectedViewers(roomID) {
		s.sendToSession(viewer.SessionID, protocol.HostStatusMessage{
			Type:   "host-status",
			Online: online,
			Paused: paused,
		})
	}
}

// handleDisconnect ports handleDisconnect. It runs once, from the reader
// goroutine's exit (D6).
func (s *Server) handleDisconnect(sess *session) {
	if !s.sessions.Has(sess) {
		return
	}
	sess.clearAuthenticationTimer()
	delete(s.senderQualityRateBySession, sess.sessionID)
	s.sessions.Delete(sess)
	if s.sessionsByID[sess.sessionID] == sess {
		delete(s.sessionsByID, sess.sessionID)
	}
	if sess.revoked {
		return
	}
	if sess.authenticated == nil {
		s.unauthenticatedConnections--
		return
	}
	if s.closing {
		return
	}

	disconnected, err := s.store.DisconnectParticipant(
		sess.authenticated.roomID, sess.authenticated.peerID, sess.sessionID)
	if err != nil {
		panic(fmt.Errorf("room store failed during disconnect: %w", err))
	}
	if disconnected == nil {
		return
	}
	s.router.disconnectParticipant(disconnected.RoomID, disconnected.PeerID, sess.sessionID)
	if disconnected.Role == protocol.RoleHost {
		s.broadcastHostStatus(disconnected.RoomID, false, false)
		s.sendViewerPresence(disconnected.RoomID)
		return
	}

	s.sendViewerPresence(disconnected.RoomID)

	// T5: the viewer grace timer. The registered-pointer check stands in
	// for clearTimeout; the store's removeDisconnectedViewer is the identity
	// guard against a viewer that reconnected meanwhile.
	roomID, peerID := disconnected.RoomID, disconnected.PeerID
	key := viewerKey(roomID, peerID)
	timer := &graceTimer{}
	timer.stop = s.afterFunc(time.Duration(s.viewerDisconnectGraceMs)*time.Millisecond, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.viewerGraceTimers[key] != timer {
			return
		}
		delete(s.viewerGraceTimers, key)
		if s.store.RemoveDisconnectedViewer(roomID, peerID) {
			s.clearViewerEvidence(roomID, peerID)
			s.router.removeViewer(roomID, peerID)
		}
	})
	s.viewerGraceTimers[key] = timer
}

// stopSharing ports stopSharing (O9: per viewer, sharing-stopped then
// host-status). The share generation deliberately survives (hazard 2).
func (s *Server) stopSharing(roomID string) {
	if current, ok := s.shares[roomID]; ok {
		s.shares[roomID] = roomShare{generation: current.generation}
	}
	s.clearRoomViewerEvidence(roomID)
	s.router.stopRoom(roomID)
	for _, viewer := range s.store.GetConnectedViewers(roomID) {
		s.sendToSession(viewer.SessionID, protocol.SharingStoppedMessage{Type: "sharing-stopped"})
		s.sendToSession(viewer.SessionID, protocol.HostStatusMessage{
			Type:   "host-status",
			Online: false,
			Paused: false,
		})
	}
}

// abandonRoom ports abandonRoom; the store error is the caller's to map.
func (s *Server) abandonRoom(roomID string) error {
	abandoned, err := s.store.AbandonRoom(roomID)
	if err != nil {
		return err
	}
	if abandoned == nil {
		return nil
	}
	s.closeRoom(*abandoned)
	return nil
}

// closeRoom closes the host session first, then
// viewers in store order, each told room-closed then closed with 1000.
func (s *Server) closeRoom(closed room.ClosedRoom) {
	s.clearRoomGraceTimers(closed.RoomID)
	s.clearRoomViewerEvidence(closed.RoomID)
	s.router.deleteRoom(closed.RoomID)
	delete(s.shares, closed.RoomID)
	for _, sessionID := range closed.SessionIDs {
		sess := s.sessionsByID[sessionID]
		if sess == nil {
			continue
		}
		s.send(sess, protocol.RoomClosedMessage{Type: "room-closed", Reason: "host-ended"})
		sess.close(websocket.StatusNormalClosure, "Room abandoned")
	}
}

// revokeGrantViewers ports revokeGrantViewers (O5): three separate passes
// over the revoked viewers, with presence deferred until the end.
func (s *Server) revokeGrantViewers(roomID string, update room.ViewerGrantUpdate) {
	if len(update.RevokedViewers) == 0 {
		return
	}
	s.deferredViewerPresenceRooms[roomID] = struct{}{}
	func() {
		defer delete(s.deferredViewerPresenceRooms, roomID)
		for _, viewer := range update.RevokedViewers {
			s.clearViewerState(roomID, viewer.PeerID)
			if viewer.SessionID == "" {
				continue
			}
			s.sendToSession(viewer.SessionID, protocol.ViewerGrantRevokedMessage{
				Type:                          "viewer-grant-revoked",
				ViewerAuthorizationGeneration: update.PreviousViewerAuthorizationGeneration,
			})
		}

		for _, viewer := range update.RevokedViewers {
			s.router.removeViewer(roomID, viewer.PeerID)
		}

		for _, viewer := range update.RevokedViewers {
			if viewer.SessionID == "" {
				continue
			}
			s.closeRevokedViewerSession(viewer.SessionID)
		}
	}()
	s.sendViewerPresence(roomID)
}

// closeRevokedViewerSession ports closeRevokedViewerSession: deauthorize
// before the close so queued callbacks of the old generation cannot route
// signaling after the persistent authorization commit.
func (s *Server) closeRevokedViewerSession(sessionID string) {
	sess := s.sessionsByID[sessionID]
	if sess == nil {
		return
	}
	if sess.sessionID == sessionID {
		sess.clearAuthenticationTimer()
		sess.revoked = true
	}
	if s.sessionsByID[sessionID] == sess {
		delete(s.sessionsByID, sessionID)
	}
	sess.close(websocket.StatusCode(protocol.SignalCloseViewerAccessRevoked), "Viewer access revoked")
}

// clearViewerGrace ports clearViewerGrace.
func (s *Server) clearViewerGrace(roomID, peerID string) {
	key := viewerKey(roomID, peerID)
	if timer, ok := s.viewerGraceTimers[key]; ok {
		timer.stop()
		delete(s.viewerGraceTimers, key)
	}
}

// clearViewerState ports clearViewerState.
func (s *Server) clearViewerState(roomID, peerID string) {
	s.clearViewerGrace(roomID, peerID)
	s.clearViewerEvidence(roomID, peerID)
}

// clearRoomGraceTimers ports clearRoomGraceTimers (O13: prefix scan; Go
// maps allow deletion during range).
func (s *Server) clearRoomGraceTimers(roomID string) {
	prefix := roomID + ":"
	for key, timer := range s.viewerGraceTimers {
		if strings.HasPrefix(key, prefix) {
			timer.stop()
			delete(s.viewerGraceTimers, key)
		}
	}
}

// clearRoomViewerEvidence ports clearRoomConnectionIds (O13) without the
// connection-ID mirror it also cleared.
func (s *Server) clearRoomViewerEvidence(roomID string) {
	prefix := roomID + ":"
	for key := range s.viewerQualityEvidenceGates {
		if strings.HasPrefix(key, prefix) {
			delete(s.viewerQualityEvidenceGates, key)
		}
	}
	for key := range s.viewerQualityEvidenceAttempts {
		if strings.HasPrefix(key, prefix) {
			delete(s.viewerQualityEvidenceAttempts, key)
		}
	}
}

// clearViewerEvidence drops one viewer's evidence gate and rate stamp.
func (s *Server) clearViewerEvidence(roomID, viewerPeerID string) {
	key := viewerKey(roomID, viewerPeerID)
	delete(s.viewerQualityEvidenceGates, key)
	delete(s.viewerQualityEvidenceAttempts, key)
}
