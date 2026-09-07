package sfuprobe

import (
	"context"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/inlivedev/sfu"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

// This is a payload fanout check, not Browser decode or adaptation acceptance.
func TestOneH264PublicationFeedsTwoReceivers(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	options := sfu.DefaultOptions()
	options.IceServers = nil
	localOnly(options.SettingEngine)
	manager := sfu.NewManager(ctx, "probe", options)
	defer manager.Close()
	roomOptions := sfu.DefaultRoomOptions()
	roomOptions.Codecs = &[]string{webrtc.MimeTypeH264, webrtc.MimeTypeOpus}
	room, err := manager.NewRoom("probe-room", "probe", sfu.RoomTypeLocal, roomOptions)
	if err != nil {
		t.Fatal(err)
	}
	failures := make(chan error, 1)
	report := func(err error) {
		if err != nil {
			select {
			case failures <- err:
			default:
			}
		}
	}
	var peers []*webrtc.PeerConnection
	defer func() {
		for _, peer := range peers {
			_ = peer.Close()
		}
	}()
	pair := func(id string, video *webrtc.TrackLocalStaticSample, receive func(*webrtc.TrackRemote)) *sfu.Client {
		settings := webrtc.SettingEngine{}
		localOnly(&settings)
		peer, err := webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
		if err != nil {
			t.Fatal(err)
		}
		peers = append(peers, peer)
		if video != nil {
			if _, err := peer.AddTrack(video); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := peer.CreateDataChannel("probe", nil); err != nil {
			t.Fatal(err)
		}
		if receive != nil {
			peer.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) { receive(track) })
		}
		clientOptions := sfu.DefaultClientOptions()
		clientOptions.IceTrickle = false
		clientOptions.EnableVoiceDetection = false
		clientOptions.EnablePlayoutDelay = false
		clientOptions.EnableOpusDTX = false
		client, err := room.AddClient(id, id, clientOptions)
		if err != nil {
			t.Fatal(err)
		}
		client.OnTracksAdded(func(tracks []sfu.ITrack) {
			sources := make(map[string]sfu.TrackType)
			for _, track := range tracks {
				sources[track.ID()] = sfu.TrackTypeScreen
			}
			client.SetTracksSourceType(sources)
		})
		client.OnRenegotiation(func(_ context.Context, offer webrtc.SessionDescription) (webrtc.SessionDescription, error) {
			if err := peer.SetRemoteDescription(offer); err != nil {
				return webrtc.SessionDescription{}, err
			}
			answer, err := peer.CreateAnswer(nil)
			if err != nil {
				return webrtc.SessionDescription{}, err
			}
			if err = peer.SetLocalDescription(answer); err != nil {
				return webrtc.SessionDescription{}, err
			}
			return *peer.LocalDescription(), nil
		})
		if receive != nil {
			client.OnTracksAvailable(func(tracks []sfu.ITrack) {
				requests := make([]sfu.SubscribeTrackRequest, 0, len(tracks))
				for _, track := range tracks {
					requests = append(requests, sfu.SubscribeTrackRequest{ClientID: track.ClientID(), TrackID: track.ID()})
				}
				report(client.SubscribeTracks(requests))
			})
		}
		offer, err := peer.CreateOffer(nil)
		if err != nil {
			t.Fatal(err)
		}
		gathered := webrtc.GatheringCompletePromise(peer)
		if err = peer.SetLocalDescription(offer); err != nil {
			t.Fatal(err)
		}
		select {
		case <-gathered:
		case <-ctx.Done():
			t.Fatal("local ICE gathering timed out")
		}
		answer, err := client.Negotiate(*peer.LocalDescription())
		if err != nil {
			t.Fatal(err)
		}
		if err = peer.SetRemoteDescription(*answer); err != nil {
			t.Fatal(err)
		}
		return client
	}
	video, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeH264, ClockRate: 90_000,
		SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
	}, "screen", "source")
	if err != nil {
		t.Fatal(err)
	}
	publisher := pair("publisher", video, nil)
	var packets [2]atomic.Int32
	var readers sync.WaitGroup
	for index := range packets {
		pair(fmt.Sprintf("receiver-%d", index), nil, func(track *webrtc.TrackRemote) {
			readers.Add(1)
			defer readers.Done()
			for {
				packet, _, err := track.ReadRTP()
				if err != nil {
					return
				}
				if len(packet.Payload) > 0 && track.Codec().MimeType == webrtc.MimeTypeH264 {
					packets[index].Add(1)
				}
			}
		})
	}
	var frame []byte
	for _, nalu := range sfu.H264KeyFrame2x2 {
		frame = append(frame, 0, 0, 0, 1)
		frame = append(frame, nalu...)
	}
	ticker := time.NewTicker(33 * time.Millisecond)
	defer ticker.Stop()
	for packets[0].Load() < 10 || packets[1].Load() < 10 {
		select {
		case <-ctx.Done():
			t.Fatalf("H264 fanout timed out: packets=%d,%d", packets[0].Load(), packets[1].Load())
		case err := <-failures:
			t.Fatal(err)
		case <-ticker.C:
			if err := video.WriteSample(media.Sample{Data: frame, Duration: 33 * time.Millisecond}); err != nil {
				t.Fatal(err)
			}
		}
	}
	if count := len(publisher.PeerConnection().PC().GetReceivers()); count != 1 {
		t.Fatalf("expected one Host RTP input, got %d", count)
	}
	if len(peers[0].GetSenders()) != 1 {
		t.Fatal("Viewer fanout added Host senders")
	}
	for _, peer := range peers {
		_ = peer.Close()
	}
	readers.Wait()
	t.Logf("one Host sender, two receivers: packets=%d,%d", packets[0].Load(), packets[1].Load())
}

func localOnly(settings *webrtc.SettingEngine) {
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(address net.IP) bool { return address.IsLoopback() })
}
