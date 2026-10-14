package nativecontrol

import (
	"encoding/hex"
	"errors"

	"github.com/TNTcraftHIM/Piik/internal/app/mediaedge"
	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

type preparePunchRequest struct {
	requestEnvelope
	ShareID            string      `json:"shareId"`
	ConnectionID       string      `json:"connectionId"`
	SourceConnectionID string      `json:"sourceConnectionId,omitempty"`
	EdgeCapacity       *int        `json:"edgeCapacity,omitempty"`
	ICEServers         []iceServer `json:"iceServers"`
	Secret             string      `json:"secret"`
}

type runPunchRequest struct {
	requestEnvelope
	ShareID      string                   `json:"shareId"`
	ConnectionID string                   `json:"connectionId"`
	Prediction   protocol.PunchPrediction `json:"prediction"`
}

type punchPreparedResponse struct {
	responseEnvelope
	Prediction *mediaedge.PunchPrediction `json:"prediction"`
}

type punchCompleteResponse struct {
	responseEnvelope
	Connected bool `json:"connected"`
}

func (session *Session) handlePunch(envelope requestEnvelope, payload []byte, complete func(any, error)) (value any, returnedErr error) {
	var done chan struct{}
	defer func() {
		if done != nil && returnedErr != nil {
			session.mu.Lock()
			session.punchDone = nil
			close(done)
			session.mu.Unlock()
		}
	}()
	switch envelope.Type {
	case "prepare-punch":
		var request preparePunchRequest
		if err := decodeStrict(payload, &request); err != nil || !validIdentities(request.ShareID, request.ConnectionID) ||
			(request.SourceConnectionID != "" && !validIdentities(request.SourceConnectionID)) ||
			(request.EdgeCapacity != nil && (*request.EdgeCapacity < 1 || *request.EdgeCapacity > maxEdgeCapacity || request.SourceConnectionID != "")) {
			return nil, protocolViolation("native connection preparation is invalid")
		}
		key, err := hex.DecodeString(request.Secret)
		if err != nil || len(key) != 32 {
			return nil, protocolViolation("native connection preparation key is invalid")
		}
		servers, err := pionICEServers(request.ICEServers)
		if err != nil {
			return nil, err
		}
		done, err = session.beginPunchOperation()
		if err != nil {
			return nil, err
		}
		var preparation *mediaedge.PunchPreparation
		if request.EdgeCapacity != nil {
			// Only a receiving request may establish a Viewer role. A late sender
			// request must not replace its retired Host/relay source with a Viewer.
			viewer, viewerErr := session.ensureViewer(request.ShareID, *request.EdgeCapacity)
			if viewerErr != nil {
				return nil, viewerErr
			}
			preparation, err = viewer.BeginPunch(request.ConnectionID, "", servers, request.Secret)
		} else if host := session.current(request.ShareID); host != nil && request.SourceConnectionID == "" {
			preparation, err = host.BeginPunch(request.ConnectionID, servers, request.Secret)
		} else if viewer := session.currentViewer(request.ShareID); viewer != nil && request.SourceConnectionID != "" {
			preparation, err = viewer.BeginPunch(request.ConnectionID, request.SourceConnectionID, servers, request.Secret)
		} else {
			return nil, errors.New("native media source does not exist")
		}
		if err != nil {
			return nil, err
		}
		// Reserve before launching work, so a subsequent close cannot be undone
		// by a late worker. This is independent of the capture mutation slot.
		go func() {
			prediction, err := preparation.Prepare()
			result := punchPreparedResponse{response(envelope, "punch-prepared"), prediction}
			complete(result, err)
			session.mu.Lock()
			session.finishOperation(&session.punchDone, done, result)
		}()
		return nil, nil
	case "run-punch":
		var request runPunchRequest
		if err := decodeStrict(payload, &request); err != nil || !validIdentities(request.ShareID, request.ConnectionID) {
			return nil, protocolViolation("native connection probe is invalid")
		}
		prediction := mediaedge.PunchPrediction(request.Prediction)
		if _, err := prediction.Target(); err != nil {
			return nil, err
		}
		media := session.currentMedia(request.ShareID)
		if media == nil {
			return nil, errors.New("native media session does not exist")
		}
		preparation := media.Punch(request.ConnectionID)
		if preparation == nil {
			return nil, errors.New("connection preparation was retired")
		}
		var err error
		done, err = session.beginPunchOperation()
		if err != nil {
			return nil, err
		}
		go func() {
			result := punchCompleteResponse{response(envelope, "punch-complete"), preparation.Run(prediction)}
			complete(result, nil)
			session.mu.Lock()
			session.finishOperation(&session.punchDone, done, result)
		}()
		return nil, nil
	case "close-punch":
		var request closeEdgeRequest
		if err := decodeStrict(payload, &request); err != nil || !validIdentities(request.ShareID, request.ConnectionID) {
			return nil, protocolViolation("native connection retirement is invalid")
		}
		if media := session.currentMedia(request.ShareID); media != nil {
			media.ClosePunch(request.ConnectionID)
		}
		return response(envelope, "punch-closed"), nil
	}
	return nil, protocolViolation("unknown connection preparation request")
}

// Bound response workers as well as socket work. Keep this slot through response
// delivery, independently of capture mutations; close-punch remains synchronous.
func (session *Session) beginPunchOperation() (chan struct{}, error) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed || session.punchDone != nil {
		return nil, errors.New("connection preparation is unavailable or already active")
	}
	done := make(chan struct{})
	session.punchDone = done
	return done, nil
}
