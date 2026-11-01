package mediaedge

import (
	"context"
	"encoding/hex"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/stun/v4"
)

// A bounded, authenticated preflight on eight fresh sockets, or the one retained
// observation socket when its mapping was stable. This function owns retained.
// All readers stop before the winner transfers to the existing Pion owner.
func punchSocketArray(ctx context.Context, listen func() (net.PacketConn, error), remote *net.UDPAddr, secret []byte, retained net.PacketConn) (net.PacketConn, error) {
	var sockets []net.PacketConn
	count := 8
	if retained != nil {
		sockets = append(sockets, retained)
		count = 1
	}
	winner := -1
	defer func() {
		for i, connection := range sockets {
			if i != winner {
				_ = connection.Close()
			}
		}
	}()
	if remote == nil || remote.IP.To4() == nil || remote.Port < 1 || remote.Port > 65535 || len(secret) != 32 {
		return nil, errors.New("invalid peer or generation secret")
	}
	parent := ctx
	ctx, cancel := context.WithTimeout(parent, 1100*time.Millisecond)
	defer cancel()
	for len(sockets) < count {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		connection, err := listen()
		if err != nil {
			return nil, err
		}
		sockets = append(sockets, connection)
	}
	for _, connection := range sockets {
		deadline, _ := ctx.Deadline()
		if err := connection.SetDeadline(deadline); err != nil {
			return nil, err
		}
	}
	integrity := stun.NewShortTermIntegrity(hex.EncodeToString(secret))
	deadlineDone := make(chan struct{})
	stopDeadline := context.AfterFunc(ctx, func() {
		defer close(deadlineDone)
		for _, connection := range sockets {
			_ = connection.SetDeadline(time.Now())
		}
	})
	requests := make([]*stun.Message, len(sockets))
	ready := make(chan int, len(sockets))
	var readers sync.WaitGroup
	var responses atomic.Int32
	var proved atomic.Bool
	var requestsLeft atomic.Int32
	requestsLeft.Store(64)
	sendCheck := func(index int, reserve int32) {
		for {
			left := requestsLeft.Load()
			if left <= reserve {
				return
			}
			if requestsLeft.CompareAndSwap(left, left-1) {
				_, _ = sockets[index].WriteTo(requests[index].Raw, remote)
				return
			}
		}
	}
	for i, connection := range sockets {
		requests[i] = stun.MustBuild(stun.TransactionID, stun.BindingRequest, integrity, stun.Fingerprint)
		readers.Add(1)
		go func() {
			defer readers.Done()
			buffer := make([]byte, 1024)
			for {
				n, addr, err := connection.ReadFrom(buffer)
				if err != nil {
					return
				}
				message := &stun.Message{Raw: buffer[:n]}
				if addr.String() != remote.String() || message.Decode() != nil || integrity.Check(message) != nil {
					continue
				}
				switch message.Type {
				case stun.BindingRequest:
					if responses.Add(1) > 64 {
						continue
					}
					reply := stun.MustBuild(stun.BindingSuccess, stun.NewTransactionIDSetter(message.TransactionID),
						&stun.XORMappedAddress{IP: remote.IP, Port: remote.Port}, integrity, stun.Fingerprint)
					_, _ = connection.WriteTo(reply.Raw, remote)
					if !proved.Load() {
						// The peer may start after our initial fanout. Check the
						// authenticated tuple through this same socket and budget.
						sendCheck(i, 0)
					}
				case stun.BindingSuccess:
					if message.TransactionID == requests[i].TransactionID {
						proved.Store(true)
						select {
						case ready <- i:
						default:
						}
					}
				}
			}
		}()
	}
	// Keep the existing eight-round send window, reserving one check per socket
	// for authenticated peer-triggered work. Both share the same 64-request bound.
	for round := 0; round < 8 && ctx.Err() == nil; round++ {
		for i := range sockets {
			if ctx.Err() != nil {
				break
			}
			sendCheck(i, int32(len(sockets)))
		}
		select {
		case <-ctx.Done():
		case <-time.After(100 * time.Millisecond):
		}
	}
	// The 800 ms initial fanout is not the 1.1-second receive budget. Retain
	// readers through that budget so delayed peer starts and replies can finish.
	<-ctx.Done()
	for _, connection := range sockets {
		_ = connection.SetReadDeadline(time.Now())
	}
	readers.Wait()
	// A cancellation callback must finish before ownership or deadline reset.
	// Otherwise it can poison the socket after Pion has already adopted it.
	if !stopDeadline() {
		<-deadlineDone
	}
	if err := parent.Err(); err != nil {
		return nil, err
	}
	select {
	case winner = <-ready:
		if err := sockets[winner].SetDeadline(time.Time{}); err != nil {
			winner = -1
			return nil, err
		}
		return sockets[winner], nil
	default:
		return nil, errors.New("bounded socket array found no authenticated tuple")
	}
}
