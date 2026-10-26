package signal

import (
	"time"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
	"github.com/TNTcraftHIM/Piik/internal/server/room"
)

type ownershipOffer struct {
	id       string
	prepared *room.PreparedOwnership
	stop     func() bool
}

func (s *Server) controlError(sess *session, code, requestID string) {
	s.send(sess, protocol.RoomControlErrorMessage{Type: "room-control-error", Code: code, RequestID: requestID})
}

func (s *Server) subscribeRoomControl(sess *session, auth *authenticatedSession) {
	if !sess.roomControl {
		token, err := s.store.IssueMemberToken(auth.roomID, auth.peerID, sess.sessionID)
		if err != nil {
			s.controlError(sess, "storage-failed", "")
			return
		}
		sess.roomControl = true
		s.send(sess, protocol.RoomControlReadyMessage{Type: "room-control-ready", Token: token, CanonicalURL: InviteURL(s.publicBaseURL, auth.roomID, "")})
	}
	s.broadcastRoomControl(auth.roomID)
}

func optionalID(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func (s *Server) broadcastRoomControl(roomID string) {
	state := s.store.ControlSnapshot(roomID)
	message := protocol.RoomControlStateMessage{CodeEntryPolicy: state.CodeEntryPolicy, ViewerPasswordEnabled: state.ViewerPasswordEnabled, Type: "room-control-state", OwnerPeerID: optionalID(state.OwnerPeerID), PresenterPeerID: optionalID(state.PresenterPeerID), ShareGeneration: optionalID(s.activeHostShareGeneration(roomID)), Members: []protocol.RoomControlMember{}}
	if offer := s.ownershipOffers[roomID]; offer != nil {
		if !s.store.IsRoomOwner(roomID, offer.prepared.Owner.PeerID, offer.prepared.Owner.SessionID) || s.sessionsByID[offer.prepared.Target.SessionID] == nil {
			s.cancelOwnershipOffer(roomID)
		} else {
			message.Transfer = &protocol.RoomOwnershipTransfer{ID: offer.id, FromPeerID: offer.prepared.Owner.PeerID, TargetPeerID: offer.prepared.Target.PeerID}
		}
	}
	for _, member := range state.Members {
		supported := false
		for _, peer := range s.roomVoiceParticipants(roomID) {
			if peer.PeerID == member.PeerID {
				if sess := s.sessionsByID[peer.SessionID]; sess != nil {
					supported = sess.roomControl
				}
				break
			}
		}
		message.Members = append(message.Members, protocol.RoomControlMember{PeerID: member.PeerID, SharingAllowed: member.SharingAllowed, Supported: supported})
	}
	for _, peer := range s.roomVoiceParticipants(roomID) {
		if sess := s.sessionsByID[peer.SessionID]; sess != nil && sess.roomControl {
			s.send(sess, message)
		}
	}
}

func (s *Server) cancelOwnershipOffer(roomID string) {
	if offer := s.ownershipOffers[roomID]; offer != nil {
		offer.stop()
		delete(s.ownershipOffers, roomID)
	}
}

func (s *Server) controlTarget(roomID, peerID string) *session {
	for _, peer := range s.roomVoiceParticipants(roomID) {
		if peer.PeerID == peerID {
			if sess := s.sessionsByID[peer.SessionID]; sess != nil && sess.roomControl && s.isCurrentSession(sess) {
				return sess
			}
		}
	}
	return nil
}

func (s *Server) handleRoomControl(sess *session, auth *authenticatedSession, command protocol.RoomControlCommand) {
	if !sess.roomControl {
		s.controlError(sess, "not-allowed", "")
		return
	}
	roomID := auth.roomID
	owner := s.store.IsRoomOwner(roomID, auth.peerID, sess.sessionID)
	switch command.Action {
	case "grant-sharing", "transfer-owner":
		if !owner {
			s.controlError(sess, "not-allowed", "")
			return
		}
		target := s.controlTarget(roomID, command.PeerID)
		if target == nil || target == sess {
			s.controlError(sess, "member-unavailable", "")
			return
		}
		if command.Action == "grant-sharing" {
			if err := s.store.SetSharingPermission(roomID, auth.peerID, sess.sessionID, command.PeerID, *command.Allowed); err != nil {
				s.controlError(sess, "not-allowed", "")
				return
			}
			if !*command.Allowed && target.authenticated.shareGeneration != "" {
				generation := target.authenticated.shareGeneration
				s.stopSharing(roomID)
				s.send(target, protocol.PresentationRevokedMessage{Type: "presentation-revoked", ShareGeneration: generation})
			}
		} else {
			prepared, err := s.store.PrepareOwnershipTransfer(roomID, auth.peerID, sess.sessionID, command.PeerID)
			if err != nil {
				s.controlError(sess, "member-unavailable", "")
				return
			}
			s.cancelOwnershipOffer(roomID)
			if s.ownershipOffers == nil {
				s.ownershipOffers = make(map[string]*ownershipOffer)
			}
			offer := &ownershipOffer{id: opaqueID(), prepared: prepared}
			offer.stop = s.afterFunc(time.Minute, func() {
				s.mu.Lock()
				defer s.mu.Unlock()
				if s.ownershipOffers[roomID] == offer {
					s.cancelOwnershipOffer(roomID)
					s.broadcastRoomControl(roomID)
				}
			})
			s.ownershipOffers[roomID] = offer
			s.send(target, protocol.RoomOwnershipOfferMessage{Type: "room-ownership-offer", OfferID: offer.id, Token: prepared.Token})
		}
	case "accept-transfer", "decline-transfer", "cancel-transfer":
		offer := s.ownershipOffers[roomID]
		if offer == nil || offer.id != command.OfferID {
			s.controlError(sess, "changed", "")
			return
		}
		if command.Action == "cancel-transfer" {
			if !owner {
				s.controlError(sess, "not-allowed", "")
				return
			}
		} else {
			if offer.prepared.Target.SessionID != sess.sessionID || offer.prepared.Target.PeerID != auth.peerID {
				s.controlError(sess, "not-allowed", "")
				return
			}
			if command.Action == "accept-transfer" {
				if err := s.store.CommitOwnershipTransfer(offer.prepared); err != nil {
					s.controlError(sess, "storage-failed", "")
					s.cancelOwnershipOffer(roomID)
					s.broadcastRoomControl(roomID)
					return
				}
				if voice := s.voices[roomID]; voice != nil {
					voice.hostPeerID = auth.peerID
					s.syncRoomVoice(roomID)
				}
			}
		}
		s.cancelOwnershipOffer(roomID)
	}
	s.broadcastRoomControl(roomID)
}

func (s *Server) authenticateMember(sess *session, message protocol.AuthenticateMemberMessage) {
	defer s.finishAuthenticating(sess)
	request := authRequest{roomID: message.RoomID, clientID: message.ClientID, displayName: displayNameString(&message.DisplayName), viewerPresence: true, roomSession: true, routePolicy: message.RoutePolicy, routePreference: message.RoutePreference, shareGeneration: message.ShareGeneration, roomOnly: message.ShareGeneration == "", qualitySettings: message.QualitySettings, sharingPaused: message.SharingPaused != nil && *message.SharingPaused}
	participant, err := s.store.ConnectMember(message.RoomID, message.Token, message.ClientID, sess.sessionID)
	if err != nil {
		s.authenticationFailed(sess, request, err)
		return
	}
	request.role = participant.Role
	if !s.store.MayShare(message.RoomID, participant.PeerID, sess.sessionID) || (s.router.sfuOnly && request.routePolicy.PeerOnly) {
		request.roomOnly = true
		request.shareGeneration = ""
	}
	s.completeAuthentication(sess, request, participant)
}

func (s *Server) claimPresentation(sess *session, auth *authenticatedSession, message protocol.ClaimPresentationMessage) {
	roomID := auth.roomID
	if !sess.roomControl || !s.store.MayShare(roomID, auth.peerID, sess.sessionID) || (s.router.sfuOnly && message.RoutePolicy.PeerOnly) {
		s.controlError(sess, "not-allowed", message.RequestID)
		return
	}
	previous := ""
	if message.PreviousGeneration != nil {
		previous = *message.PreviousGeneration
	}
	if previous != s.activeHostShareGeneration(roomID) || message.ShareGeneration == s.shares[roomID].generation {
		s.controlError(sess, "changed", message.RequestID)
		return
	}
	old, connected := s.store.GetConnectedHost(roomID)
	if connected && s.controlTarget(roomID, old.PeerID) == nil {
		s.controlError(sess, "member-unavailable", message.RequestID)
		return
	}
	s.stopSharing(roomID)
	if _, err := s.store.ClaimPresenter(roomID, auth.peerID, sess.sessionID); err != nil {
		s.controlError(sess, "not-allowed", message.RequestID)
		return
	}
	auth.role, auth.shareGeneration, auth.roomSession = protocol.RoleHost, message.ShareGeneration, true
	if former := s.sessionsByID[old.SessionID]; former != nil && former != sess {
		former.authenticated.role, former.authenticated.shareGeneration, former.authenticated.roomSession = protocol.RoleViewer, "", true
	}
	s.settleHostShare(roomID, sess.sessionID, authRequest{role: protocol.RoleHost, roomID: roomID, shareGeneration: message.ShareGeneration, qualitySettings: &message.QualitySettings, routePolicy: message.RoutePolicy})
	// Switch both media endpoints before the existing route owner emits effects.
	for _, peer := range []room.ConnectedPeer{{PeerID: auth.peerID, SessionID: sess.sessionID}, old} {
		if target := s.sessionsByID[peer.SessionID]; target != nil {
			if member, ok := s.store.ConnectedMember(roomID, peer.PeerID, peer.SessionID); ok {
				s.send(target, protocol.RoomRoleChangedMessage{Type: "room-role-changed", State: s.authenticationMessage(member, hybridAuthenticationState{routeAssignment: emptyAssignment()}, message.ShareGeneration, true)})
			}
		}
		if old.SessionID == sess.sessionID {
			break
		}
	}
	participant := routeParticipant(sess, auth)
	participant.routePolicy = &message.RoutePolicy
	state, assigned := s.connectRouteParticipant(participant)
	if !assigned {
		s.stopSharing(roomID)
		s.controlError(sess, "changed", message.RequestID)
		return
	}
	s.router.setVideoPublication(roomID, message.ShareGeneration, false)
	s.router.completeAuthentication(participant, state)
	s.sendViewerPresence(roomID)
	s.broadcastHostStatus(roomID, true, false)
}
