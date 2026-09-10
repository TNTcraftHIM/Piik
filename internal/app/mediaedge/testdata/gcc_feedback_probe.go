package main

import (
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/gcc"
	"github.com/pion/interceptor/pkg/twcc"
	"github.com/pion/logging"
	"github.com/pion/rtp"
)

const payloadBytes = 1200

type arrival struct {
	sequence uint16
	at       time.Time
}

type arm struct {
	name         string
	bwe          *gcc.SendSideBWE
	writer       interceptor.RTPWriter
	recorder     *twcc.Recorder
	capacity     int
	lastArrival  time.Time
	queue        []arrival
	sourceBudget float64
	sequence     uint16
	sent         int
	received     int
	dropped      int
	maxQueue     time.Duration
}

type observation struct {
	Second      float64        `json:"second"`
	Arm         string         `json:"arm"`
	Phase       string         `json:"phase"`
	CapacityBps int            `json:"capacityBps"`
	TargetBps   int            `json:"targetBps"`
	SourceBps   int            `json:"sourceBps"`
	SentBps     int            `json:"sentBps"`
	ReceivedBps int            `json:"receivedBps"`
	Dropped     int            `json:"droppedPackets"`
	MaxQueueMs  float64        `json:"maxQueueMs"`
	Estimator   map[string]any `json:"estimator"`
}

func newArm(name string) (*arm, error) {
	logger := logging.NewDefaultLoggerFactory()
	logger.Writer = io.Discard
	bwe, err := gcc.NewSendSideBWE(
		gcc.SendSideBWEInitialBitrate(5_000_000),
		gcc.SendSideBWEPacer(gcc.NewNoOpPacer()),
		gcc.WithLoggerFactory(logger),
	)
	if err != nil {
		return nil, err
	}
	a := &arm{name: name, bwe: bwe, recorder: twcc.NewRecorder(2)}
	info := &interceptor.StreamInfo{SSRC: 1, RTPHeaderExtensions: []interceptor.RTPHeaderExtension{
		{URI: "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01", ID: 1},
	}}
	sink := interceptor.RTPWriterFunc(func(header *rtp.Header, payload []byte, _ interceptor.Attributes) (int, error) {
		now := time.Now()
		delivery := now.Add(20 * time.Millisecond)
		if a.lastArrival.After(delivery) {
			delivery = a.lastArrival
		}
		delivery = delivery.Add(time.Duration(float64(len(payload)*8) / float64(a.capacity) * float64(time.Second)))
		a.sent += len(payload)
		if delivery.Sub(now) > 120*time.Millisecond {
			a.dropped++
			return len(payload), nil
		}
		a.lastArrival = delivery
		a.maxQueue = max(a.maxQueue, delivery.Sub(now))
		a.queue = append(a.queue, arrival{sequence: binary.BigEndian.Uint16(header.GetExtension(1)), at: delivery})
		return len(payload), nil
	})
	twccHeader := &twcc.HeaderExtensionInterceptor{}
	a.writer = twccHeader.BindLocalStream(info, bwe.AddStream(info, sink))
	return a, nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	frameBursts := flag.Bool("frame-bursts", false, "emit the payload budget in30fps frame bursts")
	flag.Parse()
	var arms []*arm
	for _, name := range []string{"low-layer-capped", "follows-budget"} {
		a, err := newArm(name)
		if err != nil {
			return err
		}
		arms = append(arms, a)
		defer a.bwe.Close()
	}
	start := time.Now()
	lastSource, nextSource := start, start
	lastReport, lastFeedback := start, start
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	var rows []observation
	payload := make([]byte, payloadBytes)
	for range ticker.C {
		now := time.Now()
		elapsed := now.Sub(start)
		if elapsed >= 40*time.Second {
			break
		}
		phase, capacity := "high", 6_000_000
		if elapsed >= 5*time.Second && elapsed < 10*time.Second {
			phase, capacity = "constrained", 500_000
		} else if elapsed >= 10*time.Second {
			phase = "released"
		}
		emitSource := !*frameBursts || !now.Before(nextSource)
		for _, a := range arms {
			a.capacity = capacity
			for len(a.queue) > 0 && !a.queue[0].at.After(now) {
				packet := a.queue[0]
				a.queue = a.queue[1:]
				a.recorder.Record(1, packet.sequence, packet.at.Sub(start).Microseconds())
				a.received += payloadBytes
			}
			sourceBps := min(5_000_000, a.bwe.GetTargetBitrate())
			if phase == "released" && a.name == "low-layer-capped" {
				sourceBps = min(sourceBps, 1_250_000)
			}
			if emitSource {
				a.sourceBudget += now.Sub(lastSource).Seconds() * float64(sourceBps) / 8
			}
			for a.sourceBudget >= payloadBytes {
				a.sourceBudget -= payloadBytes
				header := &rtp.Header{Version: 2, SSRC: 1, PayloadType: 96,
					SequenceNumber: a.sequence, Timestamp: uint32(elapsed.Seconds() * 90_000)}
				a.sequence++
				if _, err := a.writer.Write(header, payload, nil); err != nil {
					return err
				}
			}
			if now.Sub(lastFeedback) >= 100*time.Millisecond {
				if err := a.bwe.WriteRTCP(a.recorder.BuildFeedbackPacket(), nil); err != nil {
					return err
				}
			}
			if now.Sub(lastReport) >= time.Second {
				window := now.Sub(lastReport).Seconds()
				row := observation{
					Second: elapsed.Seconds(), Arm: a.name, Phase: phase, CapacityBps: capacity,
					TargetBps: a.bwe.GetTargetBitrate(), SourceBps: sourceBps,
					SentBps: int(float64(a.sent*8) / window), ReceivedBps: int(float64(a.received*8) / window),
					Dropped: a.dropped, MaxQueueMs: float64(a.maxQueue.Microseconds()) / 1000,
					Estimator: a.bwe.GetStats(),
				}
				rows = append(rows, row)
				fmt.Printf("%5.1fs %-16s %-11s target=%7d source=%7d received=%7d loss=%d state=%v\n",
					row.Second, row.Arm, row.Phase, row.TargetBps, row.SourceBps, row.ReceivedBps, row.Dropped, row.Estimator["state"])
				a.sent, a.received, a.dropped, a.maxQueue = 0, 0, 0, 0
			}
		}
		if now.Sub(lastFeedback) >= 100*time.Millisecond {
			lastFeedback = now
		}
		if now.Sub(lastReport) >= time.Second {
			lastReport = now
		}
		if emitSource {
			lastSource = now
			framePeriod := time.Second / 30
			nextSource = start.Add((elapsed/framePeriod + 1) * framePeriod)
		}
	}
	name, cadence := "build/embedded-media/gcc-feedback.json", "5ms packet budget"
	if *frameBursts {
		name, cadence = "build/embedded-media/gcc-feedback-frames.json", "30fps frame bursts"
	}
	output, err := os.Create(name)
	if err != nil {
		return err
	}
	defer output.Close()
	return json.NewEncoder(output).Encode(map[string]any{
		"pionInterceptor": "v0.1.47", "kind": "in-memory payload-rate constrained GCC/TWCC feedback",
		"initialBitrate": 5_000_000, "lowOutputCap": 1_250_000,
		"linkPropagationMs": 20, "linkMaxDelayMs": 120, "feedbackMs": 100,
		"pacer": "NoOpPacer", "observations": rows,
		"sourceCadence": cadence,
	})
}
