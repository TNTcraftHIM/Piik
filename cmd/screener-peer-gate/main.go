package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/TNTcraftHIM/Screener/internal/server/protocol"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
)

const maxPendingCandidates = 64

type gateConfig struct {
	SignalURL      string `json:"signalUrl"`
	Origin         string `json:"origin"`
	RoomID         string `json:"roomId"`
	ViewerGrant    string `json:"viewerGrant"`
	ClientID       string `json:"clientId"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
	MinPackets     int    `json:"minPackets"`
}

type signal struct {
	Kind         string                     `json:"kind"`
	ConnectionID string                     `json:"connectionId"`
	Description  *webrtc.SessionDescription `json:"description,omitempty"`
	Candidate    *webrtc.ICECandidateInit   `json:"candidate,omitempty"`
}

type wireICEServer struct {
	URLs json.RawMessage `json:"urls"`
}

type incoming struct {
	Type            string  `json:"type"`
	Sequence        uint64  `json:"sequence"`
	FromPeerID      string  `json:"fromPeerId"`
	Payload         *signal `json:"payload"`
	MediaMode       string  `json:"mediaMode"`
	RouteRevision   int     `json:"routeRevision"`
	RouteAssignment struct {
		Upstream *struct {
			Kind   string `json:"kind"`
			PeerID string `json:"peerId"`
		} `json:"upstream"`
	} `json:"routeAssignment"`
	Assignment struct {
		Upstream *struct {
			Kind   string `json:"kind"`
			PeerID string `json:"peerId"`
		} `json:"upstream"`
	} `json:"assignment"`
	ICEConfig struct {
		ICEServers []wireICEServer `json:"iceServers"`
	} `json:"iceConfig"`
	Revision     int    `json:"revision"`
	ConnectionID string `json:"connectionId"`
	Phase        string `json:"phase"`
	Candidate    struct {
		ConnectionID string `json:"connectionId"`
	} `json:"candidate"`
}

type gateResult struct {
	Passed              bool
	Connected           bool
	Packets             int
	RouteRevision       int
	ConnectionID        string
	LocalCandidateType  string
	RemoteCandidateType string
	Error               string
}

type receiver struct {
	ctx               context.Context
	conn              *websocket.Conn
	writeMu           sync.Mutex
	pc                *webrtc.PeerConnection
	pcMu              sync.Mutex
	stateMu           sync.Mutex
	parentPeerID      string
	routeRevision     int
	connectionID      string
	remoteDescription bool
	pending           []webrtc.ICECandidateInit
	pendingSignals    []struct {
		from    string
		payload signal
	}
	packetReady chan struct{}
	minPackets  int
	closeOnce   sync.Once
	packetMu    sync.Mutex
	packets     int
	localType   string
	remoteType  string
}

func main() {
	configPath := flag.String("config", "", "JSON configuration path; use - for stdin")
	flag.Parse()
	if *configPath == "" {
		writeResult(gateResult{Error: "config is required"})
		os.Exit(2)
	}
	payload, err := readConfig(*configPath)
	if err != nil {
		writeResult(gateResult{Error: "config could not be read"})
		os.Exit(1)
	}
	var config gateConfig
	if err = json.Unmarshal(payload, &config); err != nil ||
		config.SignalURL == "" || config.Origin == "" || config.RoomID == "" || config.ViewerGrant == "" {
		writeResult(gateResult{Error: "config is invalid"})
		os.Exit(1)
	}
	if config.ClientID == "" {
		config.ClientID = randomID()
	}
	if config.TimeoutSeconds < 1 || config.TimeoutSeconds > 120 {
		config.TimeoutSeconds = 45
	}
	if config.MinPackets < 1 || config.MinPackets > 300 {
		config.MinPackets = 30
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(config.TimeoutSeconds)*time.Second)
	defer cancel()
	output := run(ctx, config)
	writeResult(output)
	if !output.Passed {
		os.Exit(1)
	}
}

func readConfig(path string) ([]byte, error) {
	if path == "-" {
		return io.ReadAll(io.LimitReader(os.Stdin, 16<<10))
	}
	return os.ReadFile(path)
}

func run(ctx context.Context, config gateConfig) gateResult {
	conn, _, err := websocket.Dial(ctx, config.SignalURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{config.Origin}},
	})
	if err != nil {
		return gateResult{Error: "signaling connection failed"}
	}
	receiver := &receiver{
		ctx: ctx, conn: conn,
		packetReady: make(chan struct{}),
		minPackets:  config.MinPackets,
	}
	defer receiver.close()
	if err = receiver.write(map[string]any{
		"type": "authenticate", "protocol": protocol.SignalingProtocol,
		"roomId": config.RoomID, "role": "viewer", "clientId": config.ClientID,
		"viewerGrant": config.ViewerGrant, "viewerPresence": true,
		"displayName": "remote-gate",
	}); err != nil {
		return gateResult{Error: "authentication send failed"}
	}
	var authenticatedICE []wireICEServer
	authenticated := false
	var pendingRoute *struct {
		revision     int
		connectionID string
		parentPeerID string
	}
	activateRoute := func(revision int, connectionID string) error {
		parentPeerID, currentConnectionID, _ := receiver.routeIdentity()
		if connectionID == "" || parentPeerID == "" {
			return errors.New("receiver route is incomplete")
		}
		if currentConnectionID != "" && currentConnectionID != connectionID {
			return errors.New("receiver received a second route generation")
		}
		receiver.setRoute(parentPeerID, revision, connectionID)
		if !receiver.hasPeer() {
			if err = receiver.createPeer(authenticatedICE); err != nil {
				return err
			}
		}
		pending := receiver.pendingSignals
		receiver.pendingSignals = nil
		for _, item := range pending {
			if err = receiver.acceptSignal(item.from, item.payload); err != nil {
				return err
			}
		}
		return nil
	}
	messages := make(chan json.RawMessage, 1)
	readErrors := make(chan error, 1)
	go func() {
		for {
			var raw json.RawMessage
			readErr := wsjson.Read(ctx, conn, &raw)
			if readErr != nil {
				select {
				case readErrors <- readErr:
				case <-ctx.Done():
				}
				return
			}
			select {
			case messages <- raw:
			case <-ctx.Done():
				return
			}
		}
	}()
	for {
		select {
		case <-receiver.packetReady:
			localType, remoteType := receiver.candidateTypes()
			_, connectionID, revision := receiver.routeIdentity()
			return gateResult{
				Passed: true, Connected: true, Packets: receiver.packetCount(),
				RouteRevision: revision, ConnectionID: connectionID,
				LocalCandidateType: localType, RemoteCandidateType: remoteType,
			}
		case err = <-readErrors:
			return gateResult{Error: "signaling ended before media"}
		case <-ctx.Done():
			return gateResult{Error: "timed out waiting for remote media"}
		case raw := <-messages:
			var message incoming
			if err = json.Unmarshal(raw, &message); err != nil {
				return gateResult{Error: "signaling message is invalid"}
			}
			switch message.Type {
			case "signaling-challenge":
				if err = receiver.write(map[string]any{
					"type": "signaling-challenge", "sequence": message.Sequence,
				}); err != nil {
					return gateResult{Error: "challenge response failed"}
				}
			case "authenticated":
				if message.MediaMode != "peer-assisted" {
					return gateResult{Error: "room did not assign a direct peer route"}
				}
				if message.RouteAssignment.Upstream != nil &&
					message.RouteAssignment.Upstream.Kind == "peer" {
					receiver.setRoute(message.RouteAssignment.Upstream.PeerID, message.RouteRevision, "")
				} else {
					receiver.setRoute("", message.RouteRevision, "")
				}
				if err = receiver.write(map[string]any{
					"type": "relay-capacity", "downstreamEdges": 0,
				}); err != nil {
					return gateResult{Error: "capacity send failed"}
				}
				authenticatedICE = message.ICEConfig.ICEServers
				authenticated = true
				if pendingRoute != nil {
					receiver.setRoute(pendingRoute.parentPeerID, pendingRoute.revision, pendingRoute.connectionID)
					if err = activateRoute(pendingRoute.revision, pendingRoute.connectionID); err != nil {
						return gateResult{Error: "receiver signaling failed"}
					}
					pendingRoute = nil
				}
			case "route-update":
				if message.Phase == "prepare" && message.Candidate.ConnectionID != "" {
					if message.Assignment.Upstream == nil ||
						message.Assignment.Upstream.Kind != "peer" ||
						message.Assignment.Upstream.PeerID == "" {
						return gateResult{Error: "room did not assign a direct peer route"}
					}
					receiver.setRoute(message.Assignment.Upstream.PeerID, message.Revision, message.Candidate.ConnectionID)
					if !authenticated {
						pendingRoute = &struct {
							revision     int
							connectionID string
							parentPeerID string
						}{
							revision:     message.Revision,
							connectionID: message.Candidate.ConnectionID,
							parentPeerID: message.Assignment.Upstream.PeerID,
						}
						break
					}
					if err = activateRoute(message.Revision, message.Candidate.ConnectionID); err != nil {
						return gateResult{Error: "receiver setup failed"}
					}
				}
			case "signal":
				if message.Payload == nil {
					continue
				}
				_, connectionID, _ := receiver.routeIdentity()
				if !authenticated || connectionID == "" {
					if len(receiver.pendingSignals) >= maxPendingCandidates {
						return gateResult{Error: "receiver signaling queue is full"}
					}
					receiver.pendingSignals = append(receiver.pendingSignals, struct {
						from    string
						payload signal
					}{from: message.FromPeerID, payload: *message.Payload})
					continue
				}
				if err = receiver.acceptSignal(message.FromPeerID, *message.Payload); err != nil {
					return gateResult{Error: "receiver signaling failed"}
				}
			case "route-status":
				if message.Phase == "failed" {
					return gateResult{Error: "route assignment failed"}
				}
			}
		}
	}
}

func (receiver *receiver) createPeer(raw []wireICEServer) error {
	media := &webrtc.MediaEngine{}
	if err := media.RegisterDefaultCodecs(); err != nil {
		return err
	}
	interceptors := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(media, interceptors); err != nil {
		return err
	}
	servers, err := parseICEServers(raw)
	if err != nil {
		return err
	}
	api := webrtc.NewAPI(
		webrtc.WithMediaEngine(media),
		webrtc.WithInterceptorRegistry(interceptors),
	)
	pc, err := api.NewPeerConnection(webrtc.Configuration{ICEServers: servers})
	if err != nil {
		return err
	}
	receiver.pcMu.Lock()
	receiver.pc = pc
	receiver.pcMu.Unlock()
	if _, err = pc.AddTransceiverFromKind(
		webrtc.RTPCodecTypeVideo,
		webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly},
	); err != nil {
		return err
	}
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		var value *webrtc.ICECandidateInit
		if candidate != nil {
			converted := candidate.ToJSON()
			value = &converted
		}
		parentPeerID, connectionID, _ := receiver.routeIdentity()
		_ = receiver.write(signalMessage(
			"candidate", parentPeerID, connectionID, nil, value,
		))
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			for _, transceiver := range pc.GetTransceivers() {
				if rtpReceiver := transceiver.Receiver(); rtpReceiver != nil {
					receiver.recordSelectedPair(rtpReceiver)
					break
				}
			}
			_, connectionID, revision := receiver.routeIdentity()
			_ = receiver.write(map[string]any{
				"type":         "route-transport-connected",
				"revision":     revision,
				"connectionId": connectionID,
			})
		}
	})
	pc.OnTrack(func(track *webrtc.TrackRemote, rtpReceiver *webrtc.RTPReceiver) {
		receiver.recordSelectedPair(rtpReceiver)
		for {
			_, _, readErr := track.ReadRTP()
			if readErr != nil {
				return
			}
			receiver.packetMu.Lock()
			receiver.packets++
			count := receiver.packets
			receiver.packetMu.Unlock()
			if count == 1 {
				_, _, revision := receiver.routeIdentity()
				_ = receiver.write(map[string]any{
					"type": "route-ready", "revision": revision,
					"phase": "prepare",
				})
			}
			if count >= receiver.minPackets {
				select {
				case <-receiver.packetReady:
				default:
					close(receiver.packetReady)
				}
			}
		}
	})
	return nil
}

func (receiver *receiver) recordSelectedPair(rtpReceiver *webrtc.RTPReceiver) {
	if rtpReceiver == nil || rtpReceiver.Transport() == nil ||
		rtpReceiver.Transport().ICETransport() == nil {
		return
	}
	pair, err := rtpReceiver.Transport().ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil {
		return
	}
	receiver.packetMu.Lock()
	receiver.localType = pair.Local.Typ.String()
	receiver.remoteType = pair.Remote.Typ.String()
	receiver.packetMu.Unlock()
}

func (receiver *receiver) setRoute(parentPeerID string, revision int, connectionID string) {
	receiver.stateMu.Lock()
	receiver.parentPeerID = parentPeerID
	receiver.routeRevision = revision
	receiver.connectionID = connectionID
	receiver.stateMu.Unlock()
}

func (receiver *receiver) routeIdentity() (string, string, int) {
	receiver.stateMu.Lock()
	defer receiver.stateMu.Unlock()
	return receiver.parentPeerID, receiver.connectionID, receiver.routeRevision
}

func (receiver *receiver) hasPeer() bool {
	receiver.pcMu.Lock()
	defer receiver.pcMu.Unlock()
	return receiver.pc != nil
}

func (receiver *receiver) acceptSignal(from string, payload signal) error {
	parentPeerID, connectionID, _ := receiver.routeIdentity()
	if from != parentPeerID || payload.ConnectionID != connectionID {
		return nil
	}
	receiver.pcMu.Lock()
	pc := receiver.pc
	receiver.pcMu.Unlock()
	if pc == nil {
		return errors.New("receiver peer is not initialized")
	}
	if payload.Kind == "description" && payload.Description != nil {
		if err := pc.SetRemoteDescription(*payload.Description); err != nil {
			return err
		}
		receiver.remoteDescription = true
		for _, candidate := range receiver.pending {
			if err := pc.AddICECandidate(candidate); err != nil {
				return err
			}
		}
		receiver.pending = nil
		answer, err := pc.CreateAnswer(nil)
		if err != nil {
			return err
		}
		if err = pc.SetLocalDescription(answer); err != nil {
			return err
		}
		local := pc.LocalDescription()
		if local == nil {
			return errors.New("receiver answer is unavailable")
		}
		return receiver.write(signalMessage(
			"description", parentPeerID, connectionID, local, nil,
		))
	}
	if payload.Kind == "candidate" && payload.Candidate != nil {
		if !receiver.remoteDescription {
			if len(receiver.pending) >= maxPendingCandidates {
				return errors.New("receiver ICE queue is full")
			}
			receiver.pending = append(receiver.pending, *payload.Candidate)
			return nil
		}
		return pc.AddICECandidate(*payload.Candidate)
	}
	return nil
}

func (receiver *receiver) write(value any) error {
	receiver.writeMu.Lock()
	defer receiver.writeMu.Unlock()
	return wsjson.Write(receiver.ctx, receiver.conn, value)
}

func (receiver *receiver) packetCount() int {
	receiver.packetMu.Lock()
	defer receiver.packetMu.Unlock()
	return receiver.packets
}

func (receiver *receiver) candidateTypes() (string, string) {
	receiver.packetMu.Lock()
	defer receiver.packetMu.Unlock()
	return receiver.localType, receiver.remoteType
}

func (receiver *receiver) close() {
	receiver.closeOnce.Do(func() {
		receiver.pcMu.Lock()
		pc := receiver.pc
		receiver.pcMu.Unlock()
		if pc != nil {
			_ = pc.Close()
		}
		_ = receiver.conn.Close(websocket.StatusNormalClosure, "gate complete")
	})
}

func signalMessage(
	kind string, target string, connectionID string,
	description *webrtc.SessionDescription,
	candidate *webrtc.ICECandidateInit,
) map[string]any {
	payload := map[string]any{"kind": kind, "connectionId": connectionID}
	if description != nil {
		payload["description"] = map[string]any{
			"type": description.Type.String(), "sdp": description.SDP,
		}
	}
	if kind == "candidate" {
		payload["candidate"] = candidate
	}
	return map[string]any{"type": "signal", "targetPeerId": target, "payload": payload}
}

func parseICEServers(raw []wireICEServer) ([]webrtc.ICEServer, error) {
	servers := make([]webrtc.ICEServer, 0, len(raw))
	for _, entry := range raw {
		if len(entry.URLs) == 0 {
			continue
		}
		var values []string
		if entry.URLs[0] == '[' {
			if err := json.Unmarshal(entry.URLs, &values); err != nil {
				return nil, err
			}
		} else {
			var value string
			if err := json.Unmarshal(entry.URLs, &value); err != nil {
				return nil, err
			}
			values = []string{value}
		}
		servers = append(servers, webrtc.ICEServer{URLs: values})
	}
	return servers, nil
}

func randomID() string {
	buffer := make([]byte, 12)
	if _, err := rand.Read(buffer); err != nil {
		return "remote_gate_123456"
	}
	return fmt.Sprintf("remote_%x", buffer)
}

func writeResult(value gateResult) {
	encoded, _ := json.Marshal(map[string]any{
		"passed":              value.Passed,
		"connected":           value.Connected,
		"packets":             value.Packets,
		"routeRevision":       value.RouteRevision,
		"connectionId":        value.ConnectionID,
		"localCandidateType":  value.LocalCandidateType,
		"remoteCandidateType": value.RemoteCandidateType,
		"error":               value.Error,
	})
	fmt.Println(string(encoded))
}
