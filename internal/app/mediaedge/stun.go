package mediaedge

import (
	"context"
	"fmt"
	"net"

	"github.com/TNTcraftHIM/Piik/internal/diagnostics"
	"github.com/pion/stun/v3"
)

// Only in-flight discovery is shared. Completed observations must not survive
// into a later ICE gathering: the socket can outlive its public NAT mapping.
func (socket *iceSocket) stunMapping(ctx context.Context, server *net.UDPAddr) (*stun.XORMappedAddress, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	result := socket.stunQueries.DoChan(server.String(), func() (any, error) {
		// A retiring gathering must not cancel its successor's discovery. The
		// connection owns the transaction; callers keep their own wait deadline.
		queryContext, cancel := context.WithTimeout(socket.ctx, stunSurveyTimeout)
		defer cancel()
		return socket.querySTUN(queryContext, server)
	})
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-socket.ctx.Done():
		return nil, socket.ctx.Err()
	case outcome := <-result:
		if outcome.Err != nil {
			return nil, outcome.Err
		}
		return outcome.Val.(*stun.XORMappedAddress), nil
	}
}

func (socket *iceSocket) querySTUN(ctx context.Context, server *net.UDPAddr) (*stun.XORMappedAddress, error) {
	request := stun.MustBuild(stun.TransactionID, stun.BindingRequest)
	// Use an independent registration so late cleanup cannot retire the next
	// query or an ICE connection. The UDP socket and healthy media stay intact.
	key := fmt.Sprintf("stun-%x", request.TransactionID)
	connection, err := socket.mux.GetConn(key, socket.mux.LocalAddr())
	if err != nil {
		return nil, err
	}
	defer socket.mux.RemoveConnByUfrag(key)
	defer connection.Close()
	client, err := stun.NewClient(&stunConnection{PacketConn: connection, server: server},
		stun.WithLoggerFactory(diagnostics.PionLoggerFactory()))
	if err != nil {
		return nil, err
	}
	defer client.Close()
	type response struct {
		address *stun.XORMappedAddress
		err     error
	}
	result := make(chan response, 1)
	err = client.Start(request, func(event stun.Event) {
		if event.Error != nil {
			result <- response{err: event.Error}
			return
		}
		if event.Message.Type != stun.BindingSuccess {
			result <- response{err: fmt.Errorf("STUN binding returned %s", event.Message.Type)}
			return
		}
		var address stun.XORMappedAddress
		err := address.GetFrom(event.Message)
		result <- response{address: &address, err: err}
	})
	if err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case value := <-result:
		return value.address, value.err
	}
}

// Pion's STUN client owns transaction matching and retransmission. This view
// only addresses its packets on the existing media mux.
type stunConnection struct {
	net.PacketConn
	server *net.UDPAddr
}

func (connection *stunConnection) Read(buffer []byte) (int, error) {
	for {
		n, sender, err := connection.ReadFrom(buffer)
		if err != nil {
			return n, err
		}
		if address, ok := sender.(*net.UDPAddr); ok && address.Port == connection.server.Port &&
			address.IP.Equal(connection.server.IP) {
			return n, nil
		}
	}
}

func (connection *stunConnection) Write(buffer []byte) (int, error) {
	return connection.WriteTo(buffer, connection.server)
}
