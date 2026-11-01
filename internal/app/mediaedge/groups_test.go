package mediaedge

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/media/encoded"
	"github.com/TNTcraftHIM/Piik/internal/media/forwarding"
	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/livekit/mediatransportutil"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
)

type groupTestConsumer struct{ source *forwarding.Source }

func (consumer *groupTestConsumer) CurrentSource() *forwarding.Source { return consumer.source }
func (consumer *groupTestConsumer) ReplaceSource(next *forwarding.Source) error {
	consumer.source = next
	return nil
}

func TestOutputGroupsShareSplitRejoinAndRetire(t *testing.T) {
	engine := &Engine{}
	source, err := engine.NewSource("vp8", 2, 2, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	if err = source.SetFormat(0, 640, 360); err != nil {
		t.Fatal(err)
	}
	if err = source.SetFormat(1, 1280, 720); err != nil {
		t.Fatal(err)
	}
	if err = source.ConfigureOutputs([]uint32{500_000, 2_000_000, 500_000, 500_000}); err != nil {
		t.Fatal(err)
	}
	a, b := &groupTestConsumer{source.media.Source}, &groupTestConsumer{source.media.Source}
	demands := []outputDemand{{consumer: a, budget: 100_000, active: true, lower: true}, {consumer: b, budget: 100_000, active: true, lower: true}}
	var tick time.Duration
	plan := func() OutputPlan {
		t.Helper()
		source.writeMu.Lock()
		defer source.writeMu.Unlock()
		tick += time.Second
		if err := source.beginGroupFrame(tick, time.Unix(0, 0).Add(tick)); err != nil {
			t.Fatal(err)
		}
		value, err := source.planGroups(demands)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	shared := plan()
	if source.memberships[a] != source.memberships[b] || len(source.groups) != 1 || shared.Bitrates[0] != 100_000 || shared.Active[1] {
		t.Fatal("compatible consumers did not share one output")
	}
	demands[1].budget = 300_000
	split := plan()
	ga, gb := source.memberships[a], source.memberships[b]
	if ga == gb || split.Bitrates[ga.slot] != 100_000 || split.Bitrates[gb.slot] != 300_000 || b.CurrentSource() != source.media.Source {
		t.Fatal("different budgets coupled or moved before recovery")
	}
	source.installGroup(gb, false)
	if b.CurrentSource() != gb.media.Source {
		t.Fatal("recovery did not install prepared group")
	}
	demands[0].budget = 60_000
	changed := plan()
	if source.memberships[a] != ga || source.memberships[b] != gb || changed.Bitrates[gb.slot] != 300_000 {
		t.Fatal("one consumer's rate change altered its sibling")
	}
	demands[0].budget = 300_000
	plan()
	if source.memberships[a] != gb || a.CurrentSource() != source.media.Source {
		t.Fatal("compatible rejoin bypassed recovery")
	}
	source.installGroup(gb, false)
	rejoined := plan()
	if rejoined.Active[ga.slot] || !rejoined.Active[gb.slot] {
		t.Fatal("unused encoder did not retire after rejoin")
	}
	demands[0].lower = false
	demands[0].original = true
	pending := plan()
	if !pending.Active[1] || !pending.Active[gb.slot] || a.CurrentSource() != gb.media.Source {
		t.Fatal("original handoff retired active source")
	}
	source.installGroup(nil, true)
	if a.CurrentSource() != source.media.Source || b.CurrentSource() != gb.media.Source {
		t.Fatal("original handoff moved sibling")
	}
	demands = demands[:1]
	retired := plan()
	if retired.Active[gb.slot] {
		t.Fatal("last lower member did not release its encoder")
	}
	demands[0].active = false
	if inactive := plan(); inactive.Active[ga.slot] || inactive.Active[gb.slot] {
		t.Fatal("disconnected consumer kept an output active")
	}
	demands[0].active = true
	demands[0].lower = true
	demands[0].original = false
	demands[0].budget = 300_000
	reactivated := plan()
	if !reactivated.Active[gb.slot] || reactivated.Active[1] || source.memberships[a] != gb {
		t.Fatal("inactive compatible group could not reactivate")
	}
	source.installGroup(gb, false)
	started := gb.start
	source.groupRecovery.Store(0)
	demands[0].budget = ga.budget
	repriced := plan()
	if source.memberships[a] != gb || a.CurrentSource() != gb.media.Source ||
		!repriced.Active[gb.slot] || repriced.Active[ga.slot] || repriced.Bitrates[gb.slot] != ga.budget ||
		gb.start != started || source.groupRecovery.Load() != 0 {
		t.Fatalf("inactive budget match replaced live pipeline: member=%v source=%v active=%v rate=%d want=%d start=%v/%v recovery=%d", source.memberships[a] == gb, a.CurrentSource() == gb.media.Source, repriced.Active, repriced.Bitrates[gb.slot], ga.budget, gb.start, started, source.groupRecovery.Load())
	}
	c := &groupTestConsumer{source.media.Source}
	demands = append(demands, outputDemand{consumer: c, budget: ga.budget, active: true, lower: true})
	plan()
	if source.memberships[c] != gb {
		t.Fatal("inactive budget match took precedence over a compatible active output")
	}
	source.installGroup(gb, false)
	if settled := plan(); settled.Active[ga.slot] || c.CurrentSource() != gb.media.Source {
		t.Fatal("last handoff retained an unneeded output")
	}
	if err = gb.media.BeginFrame(tick+time.Nanosecond, time.Unix(0, 0).Add(tick+time.Nanosecond)); err != nil {
		t.Fatal(err)
	}
}

type groupLowOnlyReceiver struct{ sfu.TrackReceiver }

func (receiver groupLowOnlyReceiver) GetLayeredBitrate() ([]int32, sfu.Bitrates) {
	return []int32{0}, sfu.Bitrates{{100_000}}
}

func TestOutputGroupsHonorOriginalTransportDemand(t *testing.T) {
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	engine, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
	check(err)
	defer engine.Close()
	source, err := engine.NewSource("vp8", 2, 2, nil)
	check(err)
	defer source.Close()
	check(source.SetFormat(0, 640, 360))
	check(source.SetFormat(1, 1280, 720))
	check(source.ConfigureOutputs([]uint32{500_000, 2_000_000, 500_000}))
	edge, receiver, _ := connectedReceiver(t, engine, source, "original-demand")
	defer receiver.Close()
	plan := func(label string, original bool) {
		t.Helper()
		source.writeMu.Lock()
		defer source.writeMu.Unlock()
		value, err := source.planGroups(source.collectDemands([]*Edge{edge}, nil))
		check(err)
		if !value.Active[0] || value.Active[1] != original {
			t.Fatalf("%s plan = %+v, state = %+v", label, value, edge.transport.Output.State())
		}
	}
	plan("initial acquisition", true)
	output := edge.transport.Output
	deadline := time.Now().Add(3 * time.Second)
	for frame := 0; output.State().Current != 1; frame++ {
		if time.Now().After(deadline) {
			t.Fatalf("original never forwarded: %+v", output.State())
		}
		pts := time.Duration(frame) * time.Second / 30
		_, err = source.BeginFrame(pts)
		check(err)
		for layer := range 2 {
			check(source.WriteVideo(layer, encoded.Frame{Data: sfu.VP8KeyFrame8x8, PTS: pts,
				Duration: time.Second / 30, Recovery: true}))
		}
		time.Sleep(time.Second / 30)
	}
	plan("original target", true)
	check(edge.SetTargetLayer(0))
	if state := output.State(); state.Target != 0 || state.Current != 1 || state.Paused {
		t.Fatalf("fixture did not retain current original during lower handoff: %+v", state)
	}
	plan("original still current", true)
	output.BeginFrame()
	plan("lower handoff", false)
	edge.local = true
	plan("local lower preview", false)
	edge.local = false

	// Only the low representation is available; metadata may prepare the
	// dormant original, but may not invent its measured availability.
	output.SetReceiver(groupLowOnlyReceiver{TrackReceiver: output.Receiver()})
	edge.transport.OnTransportCCFeedback(nil, &rtcp.TransportLayerCC{})
	output.SetMaxSpatialLayer(1)
	output.SetBudget(200_000)
	plan("limited budget", false)
	output.SetBudget(2_000_000)
	// SetReceiver reset the framework's acquired layer. Its acquisition target
	// may aim at the original, but only the low layer is actually available for
	// requesting a frame; preparation is separate from accepted forwarding.
	if state := output.State(); state.Requested != 0 || state.Current > 0 || state.Prepare != 1 {
		t.Fatalf("higher budget did not prepare the dormant original: %+v", state)
	}
	plan("higher budget preparation", true)

	publication, err := engine.NewPublication(source, EdgeOptions{ConnectionID: "original-publication"})
	check(err)
	check(publication.transport.SetConnected())
	for _, count := range []int{1, 2, 0} {
		check(publication.transport.SetActiveCount(count))
		source.writeMu.Lock()
		value, err := source.planGroups(source.collectDemands(nil, []*Publication{publication}))
		source.writeMu.Unlock()
		check(err)
		if value.Active[0] != (count > 0) || value.Active[1] != (count > 1) {
			t.Fatalf("publication demand %d plan = %+v", count, value)
		}
	}
}

func newGroupLifecycleFixture(t *testing.T) (*Source, *groupTestConsumer, *outputGroup, []outputDemand) {
	t.Helper()
	source, err := (&Engine{}).NewSource("vp8", 2, 2, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = source.Close() })
	for layer, size := range [][2]uint32{{640, 360}, {1280, 720}} {
		if err = source.SetFormat(layer, size[0], size[1]); err != nil {
			t.Fatal(err)
		}
	}
	if err = source.ConfigureOutputs([]uint32{500_000, 2_000_000, 500_000, 500_000}); err != nil {
		t.Fatal(err)
	}
	a, b := &groupTestConsumer{source.media.Source}, &groupTestConsumer{source.media.Source}
	demands := []outputDemand{{consumer: a, budget: 100_000, active: true, lower: true},
		{consumer: b, budget: 300_000, active: true, lower: true}}
	if err = source.beginGroupFrame(10*time.Second, time.Unix(100, 0)); err != nil {
		t.Fatal(err)
	}
	if _, err = source.planGroups(demands); err != nil {
		t.Fatal(err)
	}
	group := source.memberships[b]
	if group == nil || group.slot < 2 {
		t.Fatal("fixture did not prepare an independent lower group")
	}
	return source, b, group, demands
}

func TestOutputGroupsPreserveCurrentDemandDuringAdmission(t *testing.T) {
	for _, pending := range []bool{false, true} {
		for _, reverse := range []bool{false, true} {
			t.Run(fmt.Sprintf("pending=%v/reverse=%v", pending, reverse), func(t *testing.T) {
				source, b, gb, demands := newGroupLifecycleFixture(t)
				a := demands[0].consumer
				ga := source.memberships[a]
				source.installGroup(ga, false)
				source.installGroup(gb, false)
				groupCount := len(source.groups)
				demands[1].budget = 100_000
				if pending {
					if _, err := source.planGroups(demands); err != nil {
						t.Fatal(err)
					}
					if source.memberships[b] != ga || b.CurrentSource() != gb.media.Source {
						t.Fatal("fixture did not prepare a compatible rejoin")
					}
				}
				source.groupRecovery.Store(0)
				demands[0].budget = 60_000
				if reverse {
					demands[0], demands[1] = demands[1], demands[0]
				}
				plan, err := source.planGroups(demands)
				if err != nil {
					t.Fatal(err)
				}
				if source.memberships[a] != ga || source.memberships[b] != gb || len(source.groups) != groupCount ||
					plan.Bitrates[ga.slot] != 60_000 || plan.Bitrates[gb.slot] != 100_000 || source.groupRecovery.Load() != 0 {
					t.Fatalf("admission displaced an incumbent: a=%v b=%v groups=%d/%d rates=%v recovery=%d",
						source.memberships[a] == ga, source.memberships[b] == gb, len(source.groups), groupCount,
						plan.Bitrates, source.groupRecovery.Load())
				}
			})
		}
	}
}

func TestOutputGroupsRetainOriginalRecoveryAfterPendingJoin(t *testing.T) {
	source, b, gb, demands := newGroupLifecycleFixture(t)
	source.installGroup(source.memberships[demands[0].consumer], false)
	source.installGroup(gb, false)
	demands[1].budget = demands[0].budget
	if _, err := source.planGroups(demands); err != nil {
		t.Fatal(err)
	}
	source.groupRecovery.Store(0)
	demands[0].budget = 60_000
	demands[1].lower, demands[1].original = false, true
	if _, err := source.planGroups(demands); err != nil {
		t.Fatal(err)
	}
	if source.memberships[b] != nil || source.groupRecovery.Load()&2 == 0 || b.CurrentSource() != gb.media.Source {
		t.Fatal("return to original lost recovery or replaced the current source early")
	}
}

func TestOutputGroupRejectsRecoveryBeforeChangingAttachment(t *testing.T) {
	for _, path := range []string{"derived", "original"} {
		for _, stamp := range []string{"future", "duplicate", "before-generation-start"} {
			t.Run(path+"/"+stamp, func(t *testing.T) {
				source, consumer, group, _ := newGroupLifecycleFixture(t)
				slot := group.slot
				if path == "original" {
					slot = 1
				}
				frame := encoded.Frame{Data: sfu.VP8KeyFrame8x8, PTS: 10 * time.Second,
					Duration: time.Second / 30, Recovery: true}
				if err := source.WriteVideo(slot, frame); err != nil {
					t.Fatal(err)
				}
				if path == "original" {
					source.installGroup(group, false)
					source.memberships[consumer] = nil
				} else {
					consumer.source = source.media.Source
				}
				previous := consumer.CurrentSource()
				if stamp == "future" {
					frame.PTS = 11 * time.Second
				} else if stamp == "before-generation-start" {
					source.BeginGeneration()
					if err := source.beginGroupFrame(time.Second, time.Unix(200, 0)); err != nil {
						t.Fatal(err)
					}
					frame.PTS = time.Second / 2
				}
				if err := source.WriteVideo(slot, frame); err == nil {
					t.Fatal("recovery without a valid input timestamp was accepted")
				}
				if consumer.CurrentSource() != previous {
					t.Fatal("rejected recovery changed the consumer's source")
				}
			})
		}
	}
}

func TestOutputGroupReactivationRejectsEarlierAccessUnits(t *testing.T) {
	source, consumer, group, demands := newGroupLifecycleFixture(t)
	source.installGroup(group, false)
	demands[1].lower = false
	demands[1].original = true
	if _, err := source.planGroups(demands); err != nil {
		t.Fatal(err)
	}
	source.installGroup(nil, true)
	if _, err := source.planGroups(demands); err != nil {
		t.Fatal(err)
	}
	if group.active {
		t.Fatal("retired group remained active")
	}
	if err := source.beginGroupFrame(12*time.Second, time.Unix(102, 0)); err != nil {
		t.Fatal(err)
	}
	demands[1].lower = true
	demands[1].original = false
	if _, err := source.planGroups(demands); err != nil {
		t.Fatal(err)
	}
	frame := encoded.Frame{Data: sfu.VP8KeyFrame8x8, PTS: 11 * time.Second,
		Duration: time.Second / 30, Recovery: true}
	if err := source.WriteVideo(group.slot, frame); err != nil {
		t.Fatal(err)
	}
	if consumer.CurrentSource() != source.media.Source {
		t.Fatal("earlier recovery installed a reactivated group")
	}
	if err := source.WriteVideo(1, frame); err != nil {
		t.Fatal(err)
	}
	if report := group.media.GetAllBuffers()[1].GetSenderReportData(); report != nil {
		t.Fatal("reactivated group borrowed an earlier original access unit")
	}
	frame.PTS = 12 * time.Second
	if err := source.WriteVideo(group.slot, frame); err != nil {
		t.Fatal(err)
	}
	if consumer.CurrentSource() != group.media.Source {
		t.Fatal("current recovery did not install the reactivated group")
	}
}

func TestOutputGroupGenerationRefreshesMetadataAndClock(t *testing.T) {
	source, consumer, group, _ := newGroupLifecycleFixture(t)
	frame := encoded.Frame{Data: sfu.VP8KeyFrame8x8, PTS: 10 * time.Second,
		Duration: time.Second / 30, Recovery: true}
	if err := source.WriteVideo(group.slot, frame); err != nil {
		t.Fatal(err)
	}
	previous := group.media.GetAllBuffers()[0].GetSenderReportData()
	if previous == nil || consumer.CurrentSource() != group.media.Source {
		t.Fatal("group did not establish its original clock and attachment")
	}
	previousTimestamp := previous.RtpTimestamp
	source.BeginGeneration()
	for layer, size := range [][2]uint32{{426, 240}, {854, 480}} {
		if err := source.SetFormat(layer, size[0], size[1]); err != nil {
			t.Fatal(err)
		}
	}
	if err := source.ConfigureOutputs([]uint32{400_000, 1_600_000, 400_000, 400_000}); err != nil {
		t.Fatal(err)
	}
	if err := source.SetFormat(group.slot, 320, 180); err != nil {
		t.Fatal(err)
	}
	info := group.media.TrackInfo()
	if source.groups[group.slot] != group || consumer.CurrentSource() != group.media.Source ||
		info.Layers[0].Width != 320 || info.Layers[0].Height != 180 || info.Layers[0].Bitrate != 400_000 ||
		info.Layers[1].Width != 854 || info.Layers[1].Height != 480 || info.Layers[1].Bitrate != 1_600_000 {
		t.Fatal("replacement source changed group identity or retained old metadata")
	}
	at := time.Unix(200, 0)
	if err := source.beginGroupFrame(time.Second, at); err != nil {
		t.Fatal(err)
	}
	frame.PTS = time.Second
	if err := source.WriteVideo(group.slot, frame); err != nil {
		t.Fatal(err)
	}
	report := group.media.GetAllBuffers()[0].GetSenderReportData()
	if report == nil || report.RtpTimestamp-previousTimestamp != 100*90_000 {
		t.Fatal("new capture generation broke the group RTP clock")
	}
	correlated, ok := group.media.ReferenceTime(0, report.RtpTimestamp)
	if !ok || correlated.Sub(at) < -time.Microsecond || correlated.Sub(at) > time.Microsecond {
		t.Fatalf("new generation correlation = %v, available=%v", correlated, ok)
	}
}

func TestLateOutputGroupKeepsSharedCaptureClock(t *testing.T) {
	source, _, _, _ := newGroupLifecycleFixture(t)
	// The capture clock advances one second while input-pipe latency grows.
	if err := source.beginGroupFrame(11*time.Second, time.Unix(101, 500_000_000)); err != nil {
		t.Fatal(err)
	}
	group, err := source.newGroup(3)
	if err != nil {
		t.Fatal(err)
	}
	write := func(pts time.Duration, expected time.Time) uint32 {
		t.Helper()
		var timestamp uint32
		for _, media := range []*forwarding.EncodedSource{source.media, group.media} {
			if err := media.WriteFrame(0, encoded.Frame{Data: sfu.VP8KeyFrame8x8,
				PTS: pts, Duration: time.Second / 30, Recovery: true}); err != nil {
				t.Fatal(err)
			}
			report := media.GetAllBuffers()[0].GetSenderReportData()
			if report == nil {
				t.Fatal("output did not establish its capture clock")
			}
			at, ok := media.ReferenceTime(0, report.RtpTimestamp)
			if !ok || at.Sub(expected).Abs() > time.Microsecond {
				t.Fatalf("output capture clock = %v, expected %v", at, expected)
			}
			timestamp = report.RtpTimestamp
		}
		return timestamp
	}
	previous := write(11*time.Second, time.Unix(101, 0))
	source.BeginGeneration()
	if err := source.beginGroupFrame(time.Second, time.Unix(200, 0)); err != nil {
		t.Fatal(err)
	}
	current := write(time.Second, time.Unix(200, 0))
	if advance := current - previous; advance != 99*90_000 {
		t.Fatalf("replacement group RTP timestamp advanced %d ticks", advance)
	}
}

func TestCaptureGenerationNormalizesOneSharedClock(t *testing.T) {
	source, err := (&Engine{}).NewSource("vp8", 2, 2, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	if err = source.ConfigureOutputs([]uint32{500_000, 2_000_000, 500_000, 500_000}); err != nil {
		t.Fatal(err)
	}
	if err = source.beginGroupFrame(10*time.Second, time.Unix(100, 0)); err != nil {
		t.Fatal(err)
	}
	if _, err = source.planGroups(nil); err != nil {
		t.Fatal(err)
	}
	group, err := source.newGroup(2)
	if err != nil {
		t.Fatal(err)
	}
	write := func(media *forwarding.EncodedSource, layer int, pts time.Duration, expected time.Time) {
		t.Helper()
		if err := media.WriteFrame(layer, encoded.Frame{Data: sfu.VP8KeyFrame8x8,
			PTS: pts, Duration: time.Second / 30, Recovery: true}); err != nil {
			t.Fatal(err)
		}
		report := media.GetAllBuffers()[layer].GetSenderReportData()
		at, ok := media.ReferenceTime(layer, report.RtpTimestamp)
		if !ok || at.Sub(expected).Abs() > time.Microsecond {
			t.Fatalf("output clock = %v, expected %v", at, expected)
		}
	}
	for _, media := range []*forwarding.EncodedSource{source.media, group.media} {
		for layer := range 2 {
			write(media, layer, 10*time.Second, time.Unix(100, 0))
		}
	}
	// Later input completes faster than the first one. Its capture timeline
	// advances to 101 even though the input arrives at 100.1.
	if err := source.beginGroupFrame(11*time.Second, time.Unix(100, 100_000_000)); err != nil {
		t.Fatal(err)
	}
	write(source.media, 0, 11*time.Second, time.Unix(101, 0))
	source.BeginGeneration()
	if err := source.beginGroupFrame(0, time.Unix(100, 200_000_000)); err != nil {
		t.Fatal(err)
	}
	origin := time.Unix(101, 0).Add(time.Second/videoClockRate + time.Nanosecond)
	write(source.media, 0, 0, origin)
	late, err := source.newGroup(3)
	if err != nil {
		t.Fatal(err)
	}
	// Original and derived outputs resume after different dormant intervals;
	// the newly created group inherits the same normalized generation origin.
	if err = source.beginGroupFrame(5*time.Second, time.Unix(100, 300_000_000)); err != nil {
		t.Fatal(err)
	}
	for _, media := range []*forwarding.EncodedSource{source.media, group.media, late.media} {
		for layer := range 2 {
			write(media, layer, 5*time.Second, origin.Add(5*time.Second))
		}
	}
	if err = source.beginGroupFrame(4*time.Second, time.Unix(200, 0)); !errors.Is(err, encoded.ErrInvalidTimestamp) {
		t.Fatalf("same-generation reverse PTS = %v", err)
	}
	source.BeginGeneration()
	if err = source.beginGroupFrame(0, time.Unix(200, 0)); err != nil {
		t.Fatal(err)
	}
	write(source.media, 0, 0, time.Unix(200, 0))
}

func TestRelayGroupSharesReceivedClockAcrossWrap(t *testing.T) {
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	source, err := (&Engine{}).newSource("vp8", 2, 2, &RelayOptions{}, nil)
	check(err)
	defer source.Close()
	check(source.SetFormat(0, 8, 8))
	check(source.SetFormat(1, 8, 8))
	check(source.ConfigureOutputs([]uint32{100_000, 1_000_000, 100_000, 100_000}))
	source.groups = make(map[int]*outputGroup)
	source.memberships = make(map[groupConsumer]*outputGroup)
	origin := time.Now()
	write := func(sequence uint16, timestamp uint32, pts time.Duration) {
		t.Helper()
		check(source.beginGroupFrame(pts, origin.Add(pts)))
		check(source.WriteRTP(&rtp.Packet{Header: rtp.Header{
			Version: 2, SSRC: 99, PayloadType: 96, SequenceNumber: sequence, Timestamp: timestamp, Marker: true,
		}, Payload: append([]byte{0x10}, sfu.VP8KeyFrame8x8...)}))
		if group := source.groups[2]; group != nil && group.active {
			copied := group.media.GetAllBuffers()[1].GetSenderReportData()
			accepted := source.media.GetAllBuffers()[1].GetSenderReportData()
			if copied == nil || copied.RtpTimestamp != accepted.RtpTimestamp || copied.NtpTimestamp != accepted.NtpTimestamp {
				t.Fatal("first copied RTP waited for another wire report")
			}
		}
		check(source.SenderReport(&rtcp.SenderReport{SSRC: 99, RTPTime: timestamp,
			NTPTime:     uint64(mediatransportutil.ToNtpTime(origin.Add(pts))),
			PacketCount: uint32(sequence), OctetCount: uint32(sequence) * 20}))
	}
	write(1, 0xffff_ff00, 0)
	write(2, 644, 10*time.Millisecond)
	// The original already observed the path; a later group first sees a delayed
	// report. That internal copy must not establish another network clock.
	time.Sleep(120 * time.Millisecond)
	group, err := source.newGroup(2)
	check(err)
	group.active = true
	earlier := &rtcp.SenderReport{SSRC: 99, RTPTime: 0xffff_ff00,
		NTPTime: uint64(mediatransportutil.ToNtpTime(origin)), PacketCount: 1, OctetCount: 20}
	check(source.SenderReport(earlier))
	if group.media.GetAllBuffers()[1].GetSenderReportData() != nil {
		t.Fatal("a group without RTP accepted a sender report")
	}
	write(3, 1544, 20*time.Millisecond)
	check(source.WriteVideo(2, encoded.Frame{Data: sfu.VP8KeyFrame8x8,
		PTS: 20 * time.Millisecond, Duration: time.Second / 30, Recovery: true}))
	// A delayed older wire report is rejected by the original owner before
	// either internal copy can adopt it.
	check(source.SenderReport(earlier))
	base := source.media.GetAllBuffers()[1].GetSenderReportData()
	copied := group.media.GetAllBuffers()[1].GetSenderReportData()
	if base == nil || copied == nil || base.RtpTimestamp != copied.RtpTimestamp ||
		base.NtpTimestamp != copied.NtpTimestamp || base.Packets != copied.Packets || base.Octets != copied.Octets {
		t.Fatal("copied original changed the accepted sender report")
	}
	if base.RtpTimestampExt-copied.RtpTimestampExt != 1<<32 {
		t.Fatal("late group did not retain its own RTP wrap epoch")
	}
	for _, media := range []*forwarding.EncodedSource{source.media, group.media} {
		for layer, buffer := range media.GetAllBuffers() {
			if buffer == nil || buffer.GetSenderReportData() == nil {
				continue
			}
			local, ok := media.LocalTime(layer, origin.Add(20*time.Millisecond))
			if !ok || local.UnixNano() != base.AtAdjusted {
				t.Fatalf("layer %d split the received clock: local=%v expected=%v", layer, local, time.Unix(0, base.AtAdjusted))
			}
		}
	}
	group.active = false
	write(4, 3344, 40*time.Millisecond)
	consumer := &groupTestConsumer{group.media.Source}
	_, err = source.planGroups([]outputDemand{{consumer: consumer, budget: group.budget, active: true, lower: true}})
	check(err)
	if !group.active {
		t.Fatal("fixture did not reactivate the relay group")
	}
	write(5, 4244, 50*time.Millisecond)
}
