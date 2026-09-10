package nativehost

import (
	"errors"

	"github.com/TNTcraftHIM/Piik/internal/app/mediaedge"
	"github.com/pion/webrtc/v4"
)

type publicationKey struct {
	generation, connectionID string
}

func (session *Session) PreparePublication(generation, connectionID string, servers []webrtc.ICEServer) (webrtc.SessionDescription, mediaedge.PublicationMedia, error) {
	session.mu.Lock()
	key := publicationKey{generation: generation, connectionID: connectionID}
	if session.closed || len(session.publications) >= 2 || session.publications[key] != nil || session.source == nil {
		session.mu.Unlock()
		return webrtc.SessionDescription{}, mediaedge.PublicationMedia{}, errors.New("native publication is unavailable")
	}
	source, audio := session.source, session.audioSource
	session.mu.Unlock()
	publication, err := session.engine.NewPublication(source, mediaedge.EdgeOptions{
		ConnectionID: connectionID, ICEServers: servers, Audio: audio,
		Events: mediaedge.EdgeEvents{
			LocalCandidate: func(candidate *webrtc.ICECandidateInit) {
				session.emit(Event{Type: "publication-candidate", ShareID: session.shareID,
					PublicationGeneration: generation, ConnectionID: connectionID, Candidate: candidate})
			},
			ConnectionState: func(state webrtc.PeerConnectionState, _ *mediaedge.SelectedPair) {
				session.emit(Event{Type: "publication-state", ShareID: session.shareID,
					PublicationGeneration: generation, ConnectionID: connectionID, State: state.String()})
			},
		},
	})
	if err != nil {
		return webrtc.SessionDescription{}, mediaedge.PublicationMedia{}, err
	}
	session.mu.Lock()
	if session.closed || len(session.publications) >= 2 || session.publications[key] != nil {
		session.mu.Unlock()
		_ = publication.Close()
		return webrtc.SessionDescription{}, mediaedge.PublicationMedia{}, errors.New("native publication changed")
	}
	if session.publications == nil {
		session.publications = make(map[publicationKey]*mediaedge.Publication)
	}
	session.publications[key] = publication
	session.mu.Unlock()
	offer, err := publication.CreateOffer()
	if err != nil {
		session.ClosePublication(generation, connectionID)
		return webrtc.SessionDescription{}, mediaedge.PublicationMedia{}, err
	}
	return offer, publication.Media(), nil
}

func (session *Session) Publication(generation, connectionID string) (*mediaedge.Publication, error) {
	session.mu.Lock()
	defer session.mu.Unlock()
	publication := session.publications[publicationKey{generation: generation, connectionID: connectionID}]
	if session.closed || publication == nil {
		return nil, errors.New("native publication identity changed")
	}
	return publication, nil
}

func (session *Session) ClosePublication(generation, connectionID string) {
	session.mu.Lock()
	key := publicationKey{generation: generation, connectionID: connectionID}
	publication := session.publications[key]
	if publication == nil {
		session.mu.Unlock()
		return
	}
	delete(session.publications, key)
	session.mu.Unlock()
	_ = publication.Close()
}
