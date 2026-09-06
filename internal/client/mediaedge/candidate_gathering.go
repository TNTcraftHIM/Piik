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
	engine     *Engine
	servers    []webrtc.ICEServer
	mappedPort int
	emit       func(*webrtc.ICECandidateInit)
	ctx        context.Context
	cancel     context.CancelFunc
	once       sync.Once

	mu               sync.Mutex
	pionDone         bool
	surveyDone       bool
	endSent          bool
	closed           bool
	mappedCandidates map[string]struct{}
}

func newLocalCandidateGathering(
	engine *Engine,
	servers []webrtc.ICEServer,
	mappedPort int,
	emit func(*webrtc.ICECandidateInit),
) *localCandidateGathering {
	ctx, cancel := context.WithCancel(engine.ctx)
	surveyServers := stunServers(servers)
	return &localCandidateGathering{
		engine: engine, servers: surveyServers, mappedPort: mappedPort, emit: emit,
		ctx: ctx, cancel: cancel, surveyDone: len(surveyServers) == 0,
		mappedCandidates: make(map[string]struct{}),
	}
}

func (gathering *localCandidateGathering) addPion(candidate *webrtc.ICECandidate) {
	if candidate != nil {
		value := candidate.ToJSON()
		gathering.emitCandidate(&value)
		return
	}
	gathering.mu.Lock()
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
			strconv.Itoa(gathering.engine.localPort),
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
			index := 0
			gathering.engine.surveySTUN(
				gathering.ctx,
				gathering.servers,
				func(mapped mappedAddress) {
					index++
					mid := "0"
					line := uint16(0)
					gathering.emitCandidate(&webrtc.ICECandidateInit{
						Candidate: "candidate:ns" + strconv.Itoa(index) +
							" 1 udp " + strconv.Itoa(surveyCandidatePriority) + " " +
							mapped.address + " " +
							strconv.Itoa(mapped.port) + " typ srflx raddr 0.0.0.0 rport " +
							strconv.Itoa(gathering.engine.localPort),
						SDPMid: &mid, SDPMLineIndex: &line,
					})
					gathering.emitMappedCandidate(mapped)
				},
			)
			gathering.mu.Lock()
			gathering.surveyDone = true
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
		gathering.emit(candidate)
	}
}

func (gathering *localCandidateGathering) finishLocked() bool {
	if gathering.closed || gathering.endSent || !gathering.pionDone ||
		!gathering.surveyDone || gathering.emit == nil {
		return false
	}
	gathering.endSent = true
	return true
}
