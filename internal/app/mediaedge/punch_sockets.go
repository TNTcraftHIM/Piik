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

// A bounded, authenticated preflight on eight fresh sockets. All readers stop
// before the single winner transfers to the existing Pion connection owner.
func punchSocketArray(ctx context.Context, listen func() (net.PacketConn, error), remote *net.UDPAddr, secret []byte) (net.PacketConn, error) {
	if remote == nil || remote.IP.To4() == nil || remote.Port < 1 || remote.Port > 65535 || len(secret) != 32 {
		return nil, errors.New("invalid peer or generation secret")
	}
	ctx, cancel := context.WithTimeout(ctx, 1100*time.Millisecond)
	defer cancel()
	var sockets []net.PacketConn
	winner := -1
	defer func() {
		for i, connection := range sockets {
			if i != winner {
				_ = connection.Close()
			}
		}
	}()
	for range 8 {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		connection, err := listen()
		if err != nil {
			return nil, err
		}
		sockets = append(sockets, connection)
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
				case stun.BindingSuccess:
					if message.TransactionID == requests[i].TransactionID {
						select {
						case ready <- i:
						default:
						}
					}
				}
			}
		}()
	}
	// Keep servicing authenticated peer requests until the finite send window
	// ends, including after a local response arrives. One peer finishing first
	// must not strand its partner before socket adoption.
	for round := 0; round < 8 && ctx.Err() == nil; round++ {
		for i, connection := range sockets {
			if ctx.Err() != nil {
				break
			}
			_, _ = connection.WriteTo(requests[i].Raw, remote)
		}
		select {
		case <-ctx.Done():
		case <-time.After(100 * time.Millisecond):
		}
	}
	for _, connection := range sockets {
		_ = connection.SetReadDeadline(time.Now())
	}
	readers.Wait()
	// A cancellation callback must finish before ownership or deadline reset.
	// Otherwise it can poison the socket after Pion has already adopted it.
	if !stopDeadline() {
		<-deadlineDone
	}
	if err := ctx.Err(); err != nil {
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
