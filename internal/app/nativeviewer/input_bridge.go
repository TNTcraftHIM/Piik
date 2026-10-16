package nativeviewer

import (
	"sync"

	"github.com/TNTcraftHIM/Piik/internal/app/remoteinput"
	"github.com/pion/webrtc/v4"
)

// An App-assisted Viewer forwards input only between its own local playback
// and its exact upstream connection. Downstream relay edges never attach here.
// The Host remains the sole input-permission owner.
type inputBridge struct {
	mu     sync.Mutex
	remote *webrtc.DataChannel
	local  *webrtc.DataChannel
	closed bool
}

func (b *inputBridge) attach(channel *webrtc.DataChannel, local bool) {
	if channel.Label() != remoteinput.ChannelLabel {
		_ = channel.Close()
		return
	}
	b.mu.Lock()
	if b.closed || !local && b.remote != nil {
		b.mu.Unlock()
		_ = channel.Close()
		return
	}
	var previous *webrtc.DataChannel
	if local {
		previous, b.local = b.local, channel
		if previous != nil {
			b.sendRemote(`{"type":"release"}`)
		}
	} else {
		b.remote = channel
	}
	b.mu.Unlock()
	if previous != nil {
		_ = previous.Close()
	}
	channel.OnOpen(func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if !b.closed && b.local != nil && b.local.ReadyState() == webrtc.DataChannelStateOpen {
			b.sendRemote(`{"type":"sync"}`)
		}
	})
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		if !message.IsString || len(message.Data) > 1024 {
			return
		}
		b.mu.Lock()
		source, target := b.remote, b.local
		if local {
			source, target = b.local, b.remote
		}
		if !b.closed && source == channel && target != nil && target.ReadyState() == webrtc.DataChannelStateOpen {
			if target.BufferedAmount() <= 8192 {
				_ = target.SendText(string(message.Data))
				b.mu.Unlock()
				return
			}
			b.mu.Unlock()
			b.close()
			return
		}
		b.mu.Unlock()
	})
	channel.OnClose(func() {
		b.mu.Lock()
		if local && b.local == channel {
			b.local = nil
			b.sendRemote(`{"type":"release"}`)
		}
		remoteClosed := !local && b.remote == channel
		b.mu.Unlock()
		if remoteClosed {
			b.close()
		}
	})
}

// Caller holds mu. No messages are queued while either leg is unavailable;
// whichever opens last requests fresh state from the Host.
func (b *inputBridge) sendRemote(message string) {
	if b.remote != nil && b.remote.ReadyState() == webrtc.DataChannelStateOpen {
		_ = b.remote.SendText(message)
	}
}

func (b *inputBridge) close() {
	b.mu.Lock()
	b.closed = true
	remote, local := b.remote, b.local
	b.remote, b.local = nil, nil
	b.mu.Unlock()
	if remote != nil {
		_ = remote.Close()
	}
	if local != nil {
		_ = local.Close()
	}
}
