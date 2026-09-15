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
		return nil, protocolViolation("native publication identity is invalid")
	}
	// Validate the command before looking up a possibly retired target.
	var servers []webrtc.ICEServer
	var answer publicationAnswerRequest
	var candidate publicationCandidateRequest
	var layers publicationLayersRequest
	switch envelope.Type {
	case "prepare-publication":
		var request preparePublicationRequest
		if err := decodeStrict(payload, &request); err != nil {
			return nil, err
		}
		var err error
		servers, err = pionICEServers(request.ICEServers)
		if err != nil {
			return nil, err
		}
	case "close-publication", "publication-media":
		if err := decodeStrict(payload, &identity); err != nil {
			return nil, err
		}
	case "publication-answer":
		if err := decodeStrict(payload, &answer); err != nil || len(answer.SDP) == 0 || len(answer.SDP) > maxSDPBytes {
			return nil, protocolViolation("native publication answer is invalid")
		}
	case "publication-candidate":
		if err := decodeStrict(payload, &candidate); err != nil || !validCandidate(candidate.Candidate) {
			return nil, protocolViolation("native publication candidate is invalid")
		}
	case "publication-layers":
		if err := decodeStrict(payload, &layers); err != nil || layers.ActiveCount == nil || *layers.ActiveCount < 0 || *layers.ActiveCount > 3 {
			return nil, protocolViolation("native publication layer demand is invalid")
		}
	}
	host := session.current(identity.ShareID)
	if envelope.Type == "close-publication" {
		if host != nil {
			host.ClosePublication(identity.PublicationGeneration, identity.ConnectionID)
		}
		return response(envelope, "publication-closed"), nil
	}
	if host == nil {
		return nil, errors.New("native share does not exist")
	}
	result := publicationResponse{ShareID: identity.ShareID,
		PublicationGeneration: identity.PublicationGeneration, ConnectionID: identity.ConnectionID}
	if envelope.Type == "prepare-publication" {
		offer, media, err := host.PreparePublication(identity.PublicationGeneration, identity.ConnectionID, servers)
		if err != nil {
			return nil, err
		}
		result.responseEnvelope, result.SDP, result.Media = response(envelope, "publication-offer"), offer.SDP, media
		return result, nil
	}
	publication, err := host.Publication(identity.PublicationGeneration, identity.ConnectionID)
	if err != nil {
		return nil, err
	}
	accepted := ""
	switch envelope.Type {
	case "publication-media":
		result.responseEnvelope, result.Media = response(envelope, "publication-media"), publication.Media()
		return result, nil
	case "publication-answer":
		err = publication.SetAnswer(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer.SDP})
		accepted = "publication-answer-accepted"
	case "publication-candidate":
		err = publication.AddRemoteCandidate(candidate.Candidate)
		accepted = "publication-candidate-accepted"
	case "publication-layers":
		err = publication.SetActiveCount(*layers.ActiveCount)
		accepted = "publication-layers-accepted"
	}
	if err != nil {
		return nil, err
	}
	return response(envelope, accepted), nil
}
