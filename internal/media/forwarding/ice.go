package forwarding

import (
	"github.com/pion/ice/v4"
	"github.com/pion/transport/v5"
	"github.com/pion/transport/v5/stdnet"
)

// NewUDPMux retains Pion's socket and candidate policy, but reads current local
// addresses at each gathering. Its default stdnet snapshot otherwise survives
// ICE restart (and every new SFU connection sharing that mux).
func NewUDPMux(params ice.UDPMuxParams) *ice.UDPMuxDefault {
	if params.Net == nil {
		params.Net = &muxNetwork{}
	}
	return ice.NewUDPMuxDefault(params)
}

// UDPMux uses Net only to enumerate interfaces. Take a fresh, private snapshot
// per read instead of mutating a shared stdnet.Net during concurrent gatherings.
type muxNetwork struct{ stdnet.Net }

func (*muxNetwork) Interfaces() ([]*transport.Interface, error) {
	network, err := stdnet.NewNet()
	if err != nil {
		return nil, err
	}
	return network.Interfaces()
}
