package pcp

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"net/netip"
	"strings"
	"testing"
)

var testNonce = [12]byte{0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08}

func TestBuildMapRequestWireFormat(t *testing.T) {
	tests := []struct {
		name             string
		clientIP         string
		protocol         uint8
		internalPort     uint16
		suggestedExtPort uint16
		suggestedExtIP   string // empty = no preference
		lifetime         uint32
		want             []byte
	}{
		{
			name:             "IPv4 mapping with suggested external",
			clientIP:         "192.168.1.10",
			protocol:         ProtoUDP,
			internalPort:     8080,
			suggestedExtPort: 9090,
			suggestedExtIP:   "203.0.113.9",
			lifetime:         7200,
			want: []byte{
				// Version, opcode MAP, reserved.
				0x02, 0x01, 0x00, 0x00,
				// Requested lifetime: 7200s.
				0x00, 0x00, 0x1c, 0x20,
				// Client IP: ::ffff:192.168.1.10.
				0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
				0x00, 0x00, 0xff, 0xff, 0xc0, 0xa8, 0x01, 0x0a,
				// Mapping nonce.
				0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
				// Protocol UDP, reserved.
				0x11, 0x00, 0x00, 0x00,
				// Internal port 8080, suggested external port 9090.
				0x1f, 0x90, 0x23, 0x82,
				// Suggested external IP: ::ffff:203.0.113.9.
				0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
				0x00, 0x00, 0xff, 0xff, 0xcb, 0x00, 0x71, 0x09,
			},
		},
		{
			name:         "IPv4 delete with no external preference",
			clientIP:     "192.168.1.10",
			protocol:     ProtoUDP,
			internalPort: 8080,
			lifetime:     0,
			want: []byte{
				// Version, opcode MAP, reserved.
				0x02, 0x01, 0x00, 0x00,
				// Requested lifetime: 0 (delete).
				0x00, 0x00, 0x00, 0x00,
				// Client IP: ::ffff:192.168.1.10.
				0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
				0x00, 0x00, 0xff, 0xff, 0xc0, 0xa8, 0x01, 0x0a,
				// Mapping nonce.
				0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
				// Protocol UDP, reserved.
				0x11, 0x00, 0x00, 0x00,
				// Internal port 8080, suggested external port 0.
				0x1f, 0x90, 0x00, 0x00,
				// Suggested external IP. RFC 6887 §11.1 + §5: no preference for an
				// IPv4 mapping is the all-zeros IPv4-mapped address ::ffff:0.0.0.0,
				// not the IPv6 unspecified address ::.
				0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
				0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00,
			},
		},
		{
			name:             "IPv6 pinhole",
			clientIP:         "2001:db8::1",
			protocol:         ProtoTCP,
			internalPort:     4242,
			suggestedExtPort: 4242,
			lifetime:         300,
			want: []byte{
				// Version, opcode MAP, reserved.
				0x02, 0x01, 0x00, 0x00,
				// Requested lifetime: 300s.
				0x00, 0x00, 0x01, 0x2c,
				// Client IP: 2001:db8::1.
				0x20, 0x01, 0x0d, 0xb8, 0x00, 0x00, 0x00, 0x00,
				0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
				// Mapping nonce.
				0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
				// Protocol TCP, reserved.
				0x06, 0x00, 0x00, 0x00,
				// Internal port 4242, suggested external port 4242.
				0x10, 0x92, 0x10, 0x92,
				// Suggested external IP: no preference for IPv6 is ::.
				0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
				0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var extIP netip.Addr
			if tt.suggestedExtIP != "" {
				extIP = netip.MustParseAddr(tt.suggestedExtIP)
			}
			got := buildMapRequest(netip.MustParseAddr(tt.clientIP), testNonce, tt.protocol,
				tt.internalPort, tt.suggestedExtPort, extIP, tt.lifetime)
			if !bytes.Equal(got, tt.want) {
				t.Errorf("buildMapRequest() =\n%swant:\n%s", hex.Dump(got), hex.Dump(tt.want))
			}
		})
	}
}

func TestParseMapResponseWireFormat(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		want MapResponse
	}{
		{
			name: "IPv4 mapping response",
			data: []byte{
				// Version, MAP reply, reserved, result SUCCESS.
				0x02, 0x81, 0x00, 0x00,
				// Lifetime: 7200s.
				0x00, 0x00, 0x1c, 0x20,
				// Epoch: 1000.
				0x00, 0x00, 0x03, 0xe8,
				// Reserved.
				0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
				// Mapping nonce.
				0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
				// Protocol UDP, reserved.
				0x11, 0x00, 0x00, 0x00,
				// Internal port 8080, assigned external port 9090.
				0x1f, 0x90, 0x23, 0x82,
				// Assigned external IP: ::ffff:203.0.113.9.
				0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
				0x00, 0x00, 0xff, 0xff, 0xcb, 0x00, 0x71, 0x09,
			},
			want: MapResponse{
				Response: Response{
					Version:    Version,
					Opcode:     OpMap | OpReply,
					ResultCode: ResultSuccess,
					Lifetime:   7200,
					Epoch:      1000,
				},
				Nonce:        testNonce,
				Protocol:     ProtoUDP,
				InternalPort: 8080,
				ExternalPort: 9090,
				ExternalIP:   netip.MustParseAddr("203.0.113.9"),
			},
		},
		{
			name: "IPv6 pinhole response",
			data: []byte{
				// Version, MAP reply, reserved, result SUCCESS.
				0x02, 0x81, 0x00, 0x00,
				// Lifetime: 300s.
				0x00, 0x00, 0x01, 0x2c,
				// Epoch: 1000.
				0x00, 0x00, 0x03, 0xe8,
				// Reserved.
				0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
				// Mapping nonce.
				0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
				// Protocol TCP, reserved.
				0x06, 0x00, 0x00, 0x00,
				// Internal port 4242, assigned external port 4242.
				0x10, 0x92, 0x10, 0x92,
				// Assigned external IP: 2001:db8::1.
				0x20, 0x01, 0x0d, 0xb8, 0x00, 0x00, 0x00, 0x00,
				0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
			},
			want: MapResponse{
				Response: Response{
					Version:    Version,
					Opcode:     OpMap | OpReply,
					ResultCode: ResultSuccess,
					Lifetime:   300,
					Epoch:      1000,
				},
				Nonce:        testNonce,
				Protocol:     ProtoTCP,
				InternalPort: 4242,
				ExternalPort: 4242,
				ExternalIP:   netip.MustParseAddr("2001:db8::1"),
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseMapResponse(tt.data)
			if err != nil {
				t.Fatalf("parseMapResponse() error = %v", err)
			}
			if *got != tt.want {
				t.Errorf("parseMapResponse() = %+v, want %+v", *got, tt.want)
			}
		})
	}
}

func TestParseMapResponseRejectsMalformed(t *testing.T) {
	valid := func() []byte {
		resp := make([]byte, mapRequestSize)
		resp[0] = Version
		resp[1] = OpMap | OpReply
		return resp
	}

	tests := []struct {
		name string
		data []byte
	}{
		{name: "empty", data: nil},
		{name: "header only", data: valid()[:headerSize]},
		{name: "one byte short", data: valid()[:mapRequestSize-1]},
		{name: "unsupported version", data: func() []byte { r := valid(); r[0] = Version + 1; return r }()},
		{name: "request, not a reply", data: func() []byte { r := valid(); r[1] = OpMap; return r }()},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := parseMapResponse(tt.data); err == nil {
				t.Fatal("parseMapResponse() error = nil, want a rejection")
			}
		})
	}
}

func TestAddrRoundTrip(t *testing.T) {
	tests := []string{"192.168.1.100", "127.0.0.1", "2001:db8::1", "::1"}
	for _, addr := range tests {
		t.Run(addr, func(t *testing.T) {
			want := netip.MustParseAddr(addr)
			if got := addrFrom16(addrTo16(want)); got != want {
				t.Fatalf("round trip = %v, want %v", got, want)
			}
		})
	}
}

func TestBuildAnnounceRequestWireFormat(t *testing.T) {
	req := buildAnnounceRequest(netip.MustParseAddr("192.168.1.100"))

	if len(req) != headerSize {
		t.Fatalf("length = %d, want %d", len(req), headerSize)
	}
	if req[0] != Version {
		t.Errorf("version = %d, want %d", req[0], Version)
	}
	if req[1] != OpAnnounce {
		t.Errorf("opcode = %d, want %d", req[1], OpAnnounce)
	}
	// RFC 6887 §5: the client address is carried as an IPv4-mapped IPv6 address.
	want := []byte{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 192, 168, 1, 100}
	if !bytes.Equal(req[8:24], want) {
		t.Errorf("client address = % x, want % x", req[8:24], want)
	}
}

func TestParseResponseRejectsMalformed(t *testing.T) {
	valid := func() []byte {
		resp := make([]byte, headerSize)
		resp[0] = Version
		resp[1] = OpAnnounce | OpReply
		binary.BigEndian.PutUint32(resp[8:12], 12345)
		return resp
	}

	t.Run("valid", func(t *testing.T) {
		parsed, err := parseResponse(valid())
		if err != nil {
			t.Fatal(err)
		}
		if parsed.ResultCode != ResultSuccess {
			t.Errorf("result code = %d, want %d", parsed.ResultCode, ResultSuccess)
		}
		if parsed.Epoch != 12345 {
			t.Errorf("epoch = %d, want 12345", parsed.Epoch)
		}
	})

	tests := []struct {
		name string
		resp []byte
	}{
		{name: "too short", resp: []byte{1, 2, 3}},
		{name: "unsupported version", resp: func() []byte { r := valid(); r[0] = Version + 1; return r }()},
		{name: "request, not a reply", resp: func() []byte { r := valid(); r[1] = OpAnnounce; return r }()},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := parseResponse(tt.resp); err == nil {
				t.Fatal("parseResponse() error = nil, want a rejection")
			}
		})
	}
}

func TestResultCodeString(t *testing.T) {
	tests := map[uint8]string{
		ResultSuccess:         "SUCCESS",
		ResultNotAuthorized:   "NOT_AUTHORIZED",
		ResultAddressMismatch: "ADDRESS_MISMATCH",
	}
	for code, want := range tests {
		if got := ResultCodeString(code); got != want {
			t.Errorf("ResultCodeString(%d) = %q, want %q", code, got, want)
		}
	}
	if got := ResultCodeString(255); !strings.Contains(got, "UNKNOWN") {
		t.Errorf("ResultCodeString(255) = %q, want it to mention UNKNOWN", got)
	}
}

func TestProtocolNumber(t *testing.T) {
	tests := []struct {
		protocol string
		want     uint8
		wantErr  bool
	}{
		{protocol: "udp", want: ProtoUDP},
		{protocol: "UDP", want: ProtoUDP},
		{protocol: "tcp", want: ProtoTCP},
		{protocol: "TCP", want: ProtoTCP},
		{protocol: "icmp", wantErr: true},
		{protocol: "", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.protocol, func(t *testing.T) {
			got, err := protocolNumber(tt.protocol)
			if (err != nil) != tt.wantErr {
				t.Fatalf("protocolNumber(%q) error = %v, wantErr %v", tt.protocol, err, tt.wantErr)
			}
			if !tt.wantErr && got != tt.want {
				t.Fatalf("protocolNumber(%q) = %d, want %d", tt.protocol, got, tt.want)
			}
		})
	}
}
