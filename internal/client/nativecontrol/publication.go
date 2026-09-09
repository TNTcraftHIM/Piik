package nativecontrol

import (
	"encoding/json"
	"errors"

	"github.com/pion/webrtc/v4"
)

func (session *Session) handlePublication(envelope requestEnvelope, payload []byte) (any, error) {
	var identity publicationIdentity
	if err := json.Unmarshal(payload, &identity); err != nil ||
		!validIdentities(identity.ShareID, identity.PublicationGeneration, identity.ConnectionID) {
		return nil, errors.New("native publication identity is invalid")
	}
	host := session.current(identity.ShareID)
	if host == nil {
		return nil, errors.New("native share does not exist")
	}
	result := publicationResponse{ShareID: identity.ShareID,
		PublicationGeneration: identity.PublicationGeneration, ConnectionID: identity.ConnectionID}
	if envelope.Type == "prepare-publication" {
		var request preparePublicationRequest
		if err := decodeStrict(payload, &request); err != nil {
			return nil, err
		}
		servers, err := pionICEServers(request.ICEServers)
		if err != nil {
			return nil, err
		}
		offer, media, err := host.PreparePublication(identity.PublicationGeneration, identity.ConnectionID, servers)
		if err != nil {
			return operationFailure(envelope, err), nil
		}
		result.responseEnvelope, result.SDP, result.Media = response(envelope, "publication-offer"), offer.SDP, media
		return result, nil
	}
	if envelope.Type == "close-publication" {
		if err := decodeStrict(payload, &identity); err != nil {
			return nil, err
		}
		host.ClosePublication(identity.PublicationGeneration, identity.ConnectionID)
		return response(envelope, "publication-closed"), nil
	}
	publication, err := host.Publication(identity.PublicationGeneration, identity.ConnectionID)
	if err != nil {
		return operationFailure(envelope, err), nil
	}
	accepted := ""
	switch envelope.Type {
	case "publication-media":
		if err = decodeStrict(payload, &identity); err != nil {
			return nil, err
		}
		result.responseEnvelope, result.Media = response(envelope, "publication-media"), publication.Media()
		return result, nil
	case "publication-answer":
		var request publicationAnswerRequest
		if err = decodeStrict(payload, &request); err != nil || len(request.SDP) == 0 || len(request.SDP) > maxSDPBytes {
			return nil, errors.New("native publication answer is invalid")
		}
		err = publication.SetAnswer(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: request.SDP})
		accepted = "publication-answer-accepted"
	case "publication-candidate":
		var request publicationCandidateRequest
		if err = decodeStrict(payload, &request); err != nil || !validCandidate(request.Candidate) {
			return nil, errors.New("native publication candidate is invalid")
		}
		err = publication.AddRemoteCandidate(request.Candidate)
		accepted = "publication-candidate-accepted"
	case "publication-layers":
		var request publicationLayersRequest
		if err = decodeStrict(payload, &request); err != nil || request.ActiveCount == nil || *request.ActiveCount < 0 || *request.ActiveCount > 3 {
			return nil, errors.New("native publication layer demand is invalid")
		}
		err = publication.SetActiveCount(*request.ActiveCount)
		accepted = "publication-layers-accepted"
	}
	if err != nil {
		return operationFailure(envelope, err), nil
	}
	return response(envelope, accepted), nil
}
