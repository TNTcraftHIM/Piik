package nativehost

import (
	"errors"

	"github.com/TNTcraftHIM/Piik/internal/app/mediaedge"
	"github.com/pion/webrtc/v4"
)

func (session *Session) BeginPunch(connectionID string, servers []webrtc.ICEServer, secret string) (*mediaedge.PunchPreparation, error) {
	session.mu.Lock()
	defer session.mu.Unlock()
	source := session.source
	if session.closed || source == nil || session.edges[connectionID] != nil {
		return nil, errors.New("native share is unavailable")
	}
	return session.engine.BeginPunch(connectionID, source, servers, secret)
}

func (session *Session) Punch(connectionID string) *mediaedge.PunchPreparation {
	return session.engine.Punch(connectionID)
}

func (session *Session) ClosePunch(connectionID string) { session.engine.ClosePunch(connectionID) }
