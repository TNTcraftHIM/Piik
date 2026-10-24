package mediaedge

import (
	"context"
	"strconv"
	"sync"

	"github.com/pion/webrtc/v4"
)

const (
	surveyCandidatePriority = 1_694_498_815
	mappedCandidatePriority = surveyCandidatePriority - (1 << 8)
)

type localCandidateGathering struct {
	socket           *iceSocket
	servers          []webrtc.ICEServer
	mappedPort       int
	prepareMapping   func() int
	usernameFragment string
	emit             func(*webrtc.ICECandidateInit)
	ctx              context.Context
	cancel           context.CancelFunc
	once             sync.Once

	mu               sync.Mutex
	pionGeneration   string
	pionDone         bool
	supplementalDone bool
	endSent          bool
	closed           bool
	mappedCandidates map[string]struct{}
}

func newLocalCandidateGathering(
	socket *iceSocket,
	servers []webrtc.ICEServer,
	prepareMapping func() int,
	usernameFragment string,
	emit func(*webrtc.ICECandidateInit),
) *localCandidateGathering {
	ctx, cancel := context.WithCancel(socket.ctx)
	surveyServers := stunServers(servers)
	return &localCandidateGathering{
		socket: socket, servers: surveyServers, prepareMapping: prepareMapping, emit: emit,
		usernameFragment: usernameFragment,
		ctx:              ctx, cancel: cancel, supplementalDone: len(surveyServers) == 0,
		mappedCandidates: make(map[string]struct{}),
	}
}

func (gathering *localCandidateGathering) addPion(candidate *webrtc.ICECandidate) {
	if candidate != nil {
		value, err := candidate.ToICE()
		if err != nil {
			return
		}
		fragment, _ := value.GetExtension("ufrag")
		gathering.mu.Lock()
		gathering.pionGeneration = fragment.Value
		gathering.mu.Unlock()
		if fragment.Value != gathering.usernameFragment {
			return
		}
		message := candidate.ToJSON()
		gathering.emitCandidate(&message)
		return
	}
	gathering.mu.Lock()
	// Pion delivers its queued candidates in order, but a new handler can
	// receive the previous generation's unscoped completion after restart.
	if gathering.pionGeneration != gathering.usernameFragment {
		gathering.mu.Unlock()
		return
	}
	gathering.pionDone = true
	sendEnd := gathering.finishLocked()
	gathering.mu.Unlock()
	if sendEnd {
		gathering.emit(nil)
	}
}

func (gathering *localCandidateGathering) emitMappedCandidate(
	mapped mappedAddress,
) {
	if gathering.mappedPort == 0 || mapped.address == "" ||
		mapped.port == gathering.mappedPort {
		return
	}
	key := mapped.address + ":" + strconv.Itoa(gathering.mappedPort)
	gathering.mu.Lock()
	if _, exists := gathering.mappedCandidates[key]; exists {
		gathering.mu.Unlock()
		return
	}
	gathering.mappedCandidates[key] = struct{}{}
	index := len(gathering.mappedCandidates)
	gathering.mu.Unlock()

	mid := "0"
	line := uint16(0)
	gathering.emitCandidate(&webrtc.ICECandidateInit{
		Candidate: "candidate:mp" + strconv.Itoa(index) +
			" 1 udp " + strconv.Itoa(mappedCandidatePriority) + " " +
			mapped.address + " " + strconv.Itoa(gathering.mappedPort) +
			" typ srflx raddr 0.0.0.0 rport " +
			strconv.Itoa(gathering.socket.localPort),
		SDPMid: &mid, SDPMLineIndex: &line,
	})
}

func (gathering *localCandidateGathering) start() {
	gathering.mu.Lock()
	closed := gathering.closed
	gathering.mu.Unlock()
	if closed {
		return
	}
	gathering.once.Do(func() {
		go func() {
			// Gateway discovery and STUN are additive: neither delays the SDP or
			// ordinary candidates. Keep end-of-candidates behind both owners.
			var mapping <-chan int
			if gathering.prepareMapping != nil && len(gathering.servers) > 0 {
				result := make(chan int, 1)
				mapping = result
				go func() { result <- gathering.prepareMapping() }()
			}
			survey := make(chan mappedAddress)
			go func() {
				defer close(survey)
				gathering.socket.surveySTUN(gathering.ctx, gathering.servers, func(mapped mappedAddress) {
					select {
					case survey <- mapped:
					case <-gathering.ctx.Done():
					}
				})
			}()
			var observed []mappedAddress
			for survey != nil || mapping != nil {
				select {
				case <-gathering.ctx.Done():
					return
				case port := <-mapping:
					gathering.mappedPort = port
					mapping = nil
					for _, mapped := range observed {
						gathering.emitMappedCandidate(mapped)
					}
					observed = nil
				case mapped, ok := <-survey:
					if !ok {
						survey = nil
						continue
					}
					mid := "0"
					line := uint16(0)
					gathering.emitCandidate(&webrtc.ICECandidateInit{
						Candidate: "candidate:ns" + strconv.Itoa(mapped.serverIndex) +
							" 1 udp " + strconv.Itoa(surveyCandidatePriority) + " " +
							mapped.address + " " +
							strconv.Itoa(mapped.port) + " typ srflx raddr 0.0.0.0 rport " +
							strconv.Itoa(gathering.socket.localPort),
						SDPMid: &mid, SDPMLineIndex: &line,
					})
					if mapping != nil {
						observed = append(observed, mapped)
					} else {
						gathering.emitMappedCandidate(mapped)
					}
				}
			}
			gathering.mu.Lock()
			gathering.supplementalDone = true
			sendEnd := gathering.finishLocked()
			gathering.mu.Unlock()
			if sendEnd {
				gathering.emit(nil)
			}
		}()
	})
}

func (gathering *localCandidateGathering) close() {
	gathering.mu.Lock()
	if gathering.closed {
		gathering.mu.Unlock()
		return
	}
	gathering.closed = true
	gathering.mu.Unlock()
	gathering.cancel()
}

func (gathering *localCandidateGathering) emitCandidate(candidate *webrtc.ICECandidateInit) {
	gathering.mu.Lock()
	closed := gathering.closed
	gathering.mu.Unlock()
	if !closed && gathering.emit != nil {
		candidate.UsernameFragment = &gathering.usernameFragment
		gathering.emit(candidate)
	}
}

func (gathering *localCandidateGathering) finishLocked() bool {
	if gathering.closed || gathering.endSent || !gathering.pionDone ||
		!gathering.supplementalDone || gathering.emit == nil {
		return false
	}
	gathering.endSent = true
	return true
}
