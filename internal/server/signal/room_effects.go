package signal

import "context"

type RoomEffectKind uint8

const (
	ViewerChat RoomEffectKind = iota + 1
	ViewerArrived
)

// RoomEffect is a transient local Host notification. Chat effects also
// expire when the share stops.
type RoomEffect struct {
	Kind RoomEffectKind
	Text string
	Done <-chan struct{}
}

func (s *Server) emitRoomEffect(roomID string, kind RoomEffectKind, text string) {
	if s.localRoomEffect == nil {
		return
	}
	host, ok := s.store.GetConnectedHost(roomID)
	if !ok {
		return
	}
	session := s.sessionsByID[host.SessionID]
	if session == nil || !session.localHost || !session.open() || session.authenticated == nil {
		return
	}
	if session.roomEffectHost == nil {
		session.roomEffectHost, session.stopRoomEffectHost = context.WithCancel(session.ctx)
	}
	lifetime := session.roomEffectHost
	if kind == ViewerChat {
		if s.activeHostShareGeneration(roomID) == "" {
			return
		}
		if session.roomEffectShare == nil {
			session.roomEffectShare, session.stopRoomEffectShare = context.WithCancel(lifetime)
		}
		lifetime = session.roomEffectShare
	}
	s.localRoomEffect(RoomEffect{Kind: kind, Text: text, Done: lifetime.Done()})
}

func (session *session) clearRoomEffectShare() {
	if session.stopRoomEffectShare != nil {
		session.stopRoomEffectShare()
		session.roomEffectShare, session.stopRoomEffectShare = nil, nil
	}
}
