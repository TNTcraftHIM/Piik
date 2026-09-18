package signal

import (
	"time"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

// Reactions borrow current room membership. They have no history, media route
// or retry queue; a departed target or an excessive click is simply discarded.
// Server.mu is held by the authenticated-message dispatcher.
func (s *Server) handleReaction(actor *authenticatedSession, message protocol.ClientReactionMessage) {
	if !actor.reactions {
		return
	}
	host, ok := s.store.GetConnectedHost(actor.roomID)
	if !ok {
		return
	}
	hostSession := s.sessionsByID[host.SessionID]
	if hostSession == nil || hostSession.authenticated == nil {
		return
	}
	hostState := hostSession.authenticated
	if hostState.shareGeneration == "" || s.shares[actor.roomID].generation != hostState.shareGeneration {
		return
	}
	now := time.UnixMilli(s.now())
	if !actor.lastReaction.IsZero() && now.Sub(actor.lastReaction) < 1200*time.Millisecond {
		return
	}

	recipients := []*session{hostSession}
	targetPresent := host.PeerID == message.TargetPeerID
	for _, viewer := range s.store.GetConnectedViewers(actor.roomID) {
		if viewer.PeerID == message.TargetPeerID {
			targetPresent = true
		}
		if recipient := s.sessionsByID[viewer.SessionID]; recipient != nil {
			recipients = append(recipients, recipient)
		}
	}
	if !targetPresent {
		return
	}
	actor.lastReaction = now
	event := protocol.ServerReactionMessage{
		Type: "reaction", ID: opaqueID(), FromPeerID: actor.peerID,
		TargetPeerID: message.TargetPeerID, Prop: message.Prop,
	}
	for _, recipient := range recipients {
		state := recipient.authenticated
		if state != nil && state.roomID == actor.roomID && state.reactions && s.isCurrentSession(recipient) {
			s.send(recipient, event)
		}
	}
}
