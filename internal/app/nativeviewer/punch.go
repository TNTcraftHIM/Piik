package nativeviewer

import (
	"errors"

	"github.com/TNTcraftHIM/Piik/internal/app/mediaedge"
	"github.com/pion/webrtc/v4"
)

func (session *Session) BeginPunch(connectionID, sourceConnectionID string, servers []webrtc.ICEServer, secret string) (*mediaedge.PunchPreparation, error) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if _, exists := session.edges[connectionID]; session.closed || exists || session.receivers[connectionID] != nil {
		return nil, errors.New("native connection is unavailable for preparation")
	}
	var source *mediaedge.Source
	if sourceConnectionID != "" {
		receiver := session.receivers[sourceConnectionID]
		if receiver == nil {
			return nil, errors.New("native Viewer source is unavailable")
		}
		source = receiver.Source()
	}
	return session.engine.BeginPunch(connectionID, source, servers, secret)
}

func (session *Session) Punch(connectionID string) *mediaedge.PunchPreparation {
	return session.engine.Punch(connectionID)
}

func (session *Session) ClosePunch(connectionID string) { session.engine.ClosePunch(connectionID) }
