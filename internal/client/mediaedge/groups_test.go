package mediaedge

import (
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/media/encoded"
	"github.com/TNTcraftHIM/Piik/internal/media/forwarding"
	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/rtcp"
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
	if state := output.State(); state.Target != 0 || state.Prepare != 1 {
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
	if report == nil || report.RtpTimestamp-previousTimestamp < 2999 || report.RtpTimestamp-previousTimestamp > 3001 {
		t.Fatal("new capture generation broke the group RTP clock")
	}
	correlated, ok := group.media.ReferenceTime(0, report.RtpTimestamp)
	if !ok || correlated.Sub(at) < -time.Microsecond || correlated.Sub(at) > time.Microsecond {
		t.Fatalf("new generation correlation = %v, available=%v", correlated, ok)
	}
}
