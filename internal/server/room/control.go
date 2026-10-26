package room

import (
	"bytes"
	"encoding/base64"
	"errors"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

// PreparedOwnership keeps the previous authority until the recipient has saved
// its new credential. The signal owner bounds the offer and commits its reply.
type PreparedOwnership struct {
	Token          string
	RoomID         string
	Owner          ConnectedPeer
	Target         ConnectedPeer
	room           *Room
	owner          *participant
	target         *participant
	previousDigest []byte
}

type MemberControl struct {
	PeerID         string
	SharingAllowed bool
}

type ControlSnapshot struct {
	CodeEntryPolicy       protocol.CodeEntryPolicy
	ViewerPasswordEnabled bool
	OwnerPeerID           string
	PresenterPeerID       string
	Members               []MemberControl
}

func participantRole(room *Room, member *participant) protocol.Role {
	if room.host == member {
		return protocol.RoleHost
	}
	return protocol.RoleViewer
}

func roomParticipant(room *Room, peerID string) *participant {
	if room.host != nil && room.host.peerID == peerID {
		return room.host
	}
	return findViewerByPeerID(room, peerID)
}

func (s *Store) IsRoomOwner(roomID, peerID, sessionID string) bool {
	room, ok := s.rooms.Get(roomID)
	return ok && room.owner != nil && sessionID != "" &&
		room.owner.peerID == peerID && room.owner.sessionID == sessionID
}

func (s *Store) GetConnectedOwner(roomID string) (ConnectedPeer, bool) {
	room, ok := s.rooms.Get(roomID)
	if !ok || room.owner == nil || room.owner.sessionID == "" {
		return ConnectedPeer{}, false
	}
	return ConnectedPeer{PeerID: room.owner.peerID, SessionID: room.owner.sessionID}, true
}

func (s *Store) ConnectedMember(roomID, peerID, sessionID string) (ConnectedParticipant, bool) {
	room, ok := s.rooms.Get(roomID)
	if !ok {
		return ConnectedParticipant{}, false
	}
	member := roomParticipant(room, peerID)
	if member == nil || sessionID == "" || member.sessionID != sessionID {
		return ConnectedParticipant{}, false
	}
	return connectedParticipant(room, peerID, participantRole(room, member), "", sessionID), true
}

func (s *Store) MayShare(roomID, peerID, sessionID string) bool {
	room, ok := s.rooms.Get(roomID)
	if !ok {
		return false
	}
	member := roomParticipant(room, peerID)
	return member != nil && sessionID != "" && member.sessionID == sessionID && (member == room.owner || member.sharingAllowed)
}

func (s *Store) ControlSnapshot(roomID string) ControlSnapshot {
	room, ok := s.rooms.Get(roomID)
	result := ControlSnapshot{Members: []MemberControl{}}
	if !ok {
		return result
	}
	result.CodeEntryPolicy = room.codeEntryPolicy
	result.ViewerPasswordEnabled = len(room.viewerPasswordMaterial) > 0
	if room.owner != nil {
		result.OwnerPeerID = room.owner.peerID
	}
	if room.host != nil {
		result.PresenterPeerID = room.host.peerID
	}
	add := func(member *participant) {
		if member != nil && member.sessionID != "" {
			result.Members = append(result.Members, MemberControl{member.peerID, member == room.owner || member.sharingAllowed})
		}
	}
	add(room.host)
	for _, member := range room.viewers.Values() {
		add(member)
	}
	return result
}

// Member credentials resume this admitted participant, including a changed
// media role. They never grant ownership and disappear with room membership.
func (s *Store) IssueMemberToken(roomID, peerID, sessionID string) (string, error) {
	room, err := s.getAvailableRoom(roomID)
	if err != nil {
		return "", err
	}
	member := roomParticipant(room, peerID)
	if member == nil || sessionID == "" || member.sessionID != sessionID {
		return "", codeError(CodeInvalidToken)
	}
	secret := s.random(32)
	if len(secret) != 32 {
		return "", errors.New("Member token random source must return 32 bytes")
	}
	token := base64.RawURLEncoding.EncodeToString(secret)
	member.memberTokenDigest = digest(token)
	return token, nil
}

func (s *Store) ConnectMember(roomID, token, clientID, sessionID string) (ConnectedParticipant, error) {
	room, err := s.getAvailableRoom(roomID)
	if err != nil {
		return ConnectedParticipant{}, err
	}
	member := room.host
	if member == nil || member.clientID != clientID {
		member, _ = room.viewers.Get(clientID)
	}
	if member == nil || len(member.memberTokenDigest) == 0 || !verifyDigest(token, member.memberTokenDigest) {
		return ConnectedParticipant{}, codeError(CodeInvalidToken)
	}
	replaced := member.sessionID
	member.sessionID = sessionID
	return connectedParticipant(room, member.peerID, participantRole(room, member), replaced, sessionID), nil
}

func (s *Store) SetSharingPermission(roomID, ownerPeerID, ownerSessionID, peerID string, allowed bool) error {
	if !s.IsRoomOwner(roomID, ownerPeerID, ownerSessionID) {
		return codeError(CodeInvalidToken)
	}
	room, _ := s.rooms.Get(roomID)
	member := roomParticipant(room, peerID)
	if member == nil || member.sessionID == "" || member == room.owner {
		return codeError(CodeRoomAccessDenied)
	}
	member.sharingAllowed = allowed
	return nil
}

// ClaimPresenter changes only the media role. The caller serializes the source
// generation check and retirement through the existing room route controller.
func (s *Store) ClaimPresenter(roomID, peerID, sessionID string) (ConnectedPeer, error) {
	room, err := s.getAvailableRoom(roomID)
	if err != nil {
		return ConnectedPeer{}, err
	}
	member := roomParticipant(room, peerID)
	if member == nil || member.sessionID != sessionID || sessionID == "" || !(member == room.owner || member.sharingAllowed) {
		return ConnectedPeer{}, codeError(CodeRoomAccessDenied)
	}
	previous := room.host
	if previous == member {
		return ConnectedPeer{PeerID: peerID, SessionID: sessionID}, nil
	}
	room.viewers.Delete(member.clientID)
	if previous != nil {
		room.viewers.Set(previous.clientID, previous)
	}
	room.host = member
	if previous == nil {
		return ConnectedPeer{}, nil
	}
	return ConnectedPeer{PeerID: previous.peerID, SessionID: previous.sessionID}, nil
}

func (s *Store) PrepareOwnershipTransfer(roomID, ownerPeerID, ownerSessionID, targetPeerID string) (*PreparedOwnership, error) {
	if !s.IsRoomOwner(roomID, ownerPeerID, ownerSessionID) {
		return nil, codeError(CodeInvalidToken)
	}
	room, _ := s.rooms.Get(roomID)
	target := roomParticipant(room, targetPeerID)
	if target == nil || target == room.owner || target.sessionID == "" {
		return nil, codeError(CodeRoomAccessDenied)
	}
	secret := s.random(32)
	if len(secret) != 32 {
		return nil, errors.New("Host token random source must return 32 bytes")
	}
	return &PreparedOwnership{Token: base64.RawURLEncoding.EncodeToString(secret), RoomID: roomID,
		Owner:  ConnectedPeer{PeerID: room.owner.peerID, SessionID: room.owner.sessionID},
		Target: ConnectedPeer{PeerID: target.peerID, SessionID: target.sessionID},
		room:   room, owner: room.owner, target: target, previousDigest: bytes.Clone(room.hostTokenDigest)}, nil
}

func (s *Store) CommitOwnershipTransfer(offer *PreparedOwnership) error {
	current, ok := s.rooms.Get(offer.RoomID)
	if !ok || current != offer.room || current.owner != offer.owner || !bytes.Equal(current.hostTokenDigest, offer.previousDigest) ||
		offer.owner.sessionID != offer.Owner.SessionID || offer.target.sessionID != offer.Target.SessionID ||
		roomParticipant(current, offer.Target.PeerID) != offer.target {
		return codeError(CodeInvalidToken)
	}
	nextDigest := digest(offer.Token)
	if err := s.writeDatabase(func() error {
		return s.database.SetHostToken(offer.RoomID, current.hostTokenDigest, nextDigest)
	}); err != nil {
		return err
	}
	current.hostTokenDigest = nextDigest
	current.owner.sharingAllowed = true
	current.owner = offer.target
	current.owner.admittedBy = admittedByOwner
	return nil
}
