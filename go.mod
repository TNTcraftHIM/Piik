module github.com/TNTcraftHIM/Piik

go 1.27.2

// Scoped NAT-PMP fixes; provenance and removal criteria: internal/thirdparty/README.md.
replace github.com/netbirdio/go-nat => ./internal/thirdparty/go-nat

replace github.com/jackpal/go-nat-pmp => ./internal/thirdparty/go-nat-pmp

require (
	charm.land/bubbletea/v2 v2.0.9
	charm.land/lipgloss/v2 v2.0.6
	github.com/bluenviron/mediacommon/v2 v2.9.5
	github.com/charmbracelet/colorprofile v0.4.3
	github.com/charmbracelet/x/ansi v0.11.8
	github.com/charmbracelet/x/term v0.2.2
	github.com/coder/websocket v1.8.15
	github.com/go-logr/logr v1.4.4
	github.com/livekit/livekit-server v1.13.11-0.20261014174133-18df6ad4b694
	github.com/livekit/mediatransportutil v0.0.0-20260821083140-f234b534b095
	github.com/livekit/protocol v1.52.2-0.20261012065025-9bb708cdb819
	github.com/livekit/server-sdk-go/v2 v2.14.0
	github.com/netbirdio/go-nat v0.0.0-20260821095157-6b2c8c5c74e8
	github.com/pion/ice/v4 v4.4.7
	github.com/pion/interceptor v0.1.49
	github.com/pion/logging v0.2.4
	github.com/pion/rtcp v1.2.19
	github.com/pion/rtp v1.10.5
	github.com/pion/sdp/v3 v3.0.20
	github.com/pion/stun/v4 v4.0.1
	github.com/pion/transport/v5 v5.1.1
	github.com/pion/turn/v5 v5.1.2
	github.com/pion/webrtc/v4 v4.2.23
	github.com/thesyncim/gopus v0.2.2
	go.uber.org/zap v1.28.0
	golang.org/x/crypto v0.57.0
	golang.org/x/mod v0.41.0
	golang.org/x/net v0.60.0
	golang.org/x/sync v0.23.0
	golang.org/x/text v0.42.0
	google.golang.org/protobuf v1.36.12
	modernc.org/sqlite v1.58.0
)

require (
	buf.build/gen/go/bufbuild/protovalidate/protocolbuffers/go v1.36.12-20260825204119-511051f7f437.2 // indirect
	buf.build/go/protovalidate v1.4.0 // indirect
	buf.build/go/protoyaml v0.7.0 // indirect
	cel.dev/cel-go v0.32.0 // indirect
	cel.dev/expr v0.25.3 // indirect
	github.com/antlr4-go/antlr/v4 v4.13.1 // indirect
	github.com/benbjohnson/clock v1.3.5 // indirect
	github.com/beorn7/perks v1.0.1 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/charmbracelet/ultraviolet v0.0.0-20260811164956-006e29f97886 // indirect
	github.com/charmbracelet/x/termios v0.1.1 // indirect
	github.com/charmbracelet/x/windows v0.2.2 // indirect
	github.com/clipperhouse/displaywidth v0.11.0 // indirect
	github.com/clipperhouse/uax29/v2 v2.7.0 // indirect
	github.com/dennwc/iters v1.2.2 // indirect
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/elliotchance/orderedmap/v3 v3.1.1 // indirect
	github.com/florianl/go-tc v0.4.8 // indirect
	github.com/frostbyte73/core v0.1.1 // indirect
	github.com/fsnotify/fsnotify v1.10.1 // indirect
	github.com/gammazero/deque v1.2.1 // indirect
	github.com/go-logr/stdr v1.2.2 // indirect
	github.com/golang-jwt/jwt/v5 v5.3.1 // indirect
	github.com/google/cel-go v0.30.0 // indirect
	github.com/google/go-cmp v0.7.0 // indirect
	github.com/google/gopacket v1.1.19 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/hashicorp/go-cleanhttp v0.5.2 // indirect
	github.com/hashicorp/go-retryablehttp v0.7.8 // indirect
	github.com/huin/goupnp v1.2.0 // indirect
	github.com/jackpal/go-nat-pmp v1.0.2 // indirect
	github.com/jellydator/ttlcache/v3 v3.4.1 // indirect
	github.com/josharian/native v1.1.0 // indirect
	github.com/jxskiss/base62 v1.1.0 // indirect
	github.com/klauspost/compress v1.20.1 // indirect
	github.com/klauspost/cpuid/v2 v2.4.0 // indirect
	github.com/koron/go-ssdp v0.0.4 // indirect
	github.com/libp2p/go-netroute v0.2.1 // indirect
	github.com/lithammer/shortuuid/v4 v4.3.0 // indirect
	github.com/livekit/mageutil v0.0.0-20250511045019-0f1ff63f7731 // indirect
	github.com/livekit/psrpc v0.8.2 // indirect
	github.com/lucasb-eyer/go-colorful v1.4.1 // indirect
	github.com/mackerelio/go-osstat v0.2.8 // indirect
	github.com/magefile/mage v1.17.2 // indirect
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/mattn/go-runewidth v0.0.24 // indirect
	github.com/mdlayher/netlink v1.11.2 // indirect
	github.com/mdlayher/socket v0.6.1 // indirect
	github.com/muesli/cancelreader v0.2.2 // indirect
	github.com/munnerz/goautoneg v0.0.0-20191010083416-a7dc8b61c822 // indirect
	github.com/nats-io/nats.go v1.53.1 // indirect
	github.com/nats-io/nkeys v0.4.16 // indirect
	github.com/nats-io/nuid v1.0.1 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/petermattis/goid v0.0.0-20260918085751-abfca077860b // indirect
	github.com/pion/datachannel v1.6.3 // indirect
	github.com/pion/dtls/v3 v3.1.10 // indirect
	github.com/pion/mdns/v2 v2.2.2 // indirect
	github.com/pion/randutil v0.1.0 // indirect
	github.com/pion/sctp v1.12.0 // indirect
	github.com/pion/srtp/v3 v3.1.3 // indirect
	github.com/pion/transport/v4 v4.1.1 // indirect
	github.com/prometheus/client_golang v1.24.1 // indirect
	github.com/prometheus/client_model v0.6.3 // indirect
	github.com/prometheus/common v0.72.0 // indirect
	github.com/prometheus/procfs v0.22.0 // indirect
	github.com/puzpuzpuz/xsync/v4 v4.5.0 // indirect
	github.com/redis/go-redis/v9 v9.22.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	github.com/rivo/uniseg v0.4.7 // indirect
	github.com/twitchtv/twirp v8.1.3+incompatible // indirect
	github.com/wlynxg/anet v0.0.5 // indirect
	github.com/xo/terminfo v0.0.0-20220910002029-abceb7e1c41e // indirect
	github.com/zeebo/xxh3 v1.1.0 // indirect
	go.opentelemetry.io/auto/sdk v1.2.1 // indirect
	go.opentelemetry.io/otel v1.47.0 // indirect
	go.opentelemetry.io/otel/log v1.47.0 // indirect
	go.opentelemetry.io/otel/metric v1.47.0 // indirect
	go.opentelemetry.io/otel/trace v1.47.0 // indirect
	go.uber.org/atomic v1.12.0 // indirect
	go.uber.org/multierr v1.11.0 // indirect
	go.uber.org/zap/exp v0.3.0 // indirect
	go.yaml.in/yaml/v3 v3.0.5 // indirect
	golang.org/x/exp v0.0.0-20261005173118-76772065c9b0 // indirect
	golang.org/x/sys v0.48.0 // indirect
	golang.org/x/time v0.16.0 // indirect
	google.golang.org/genproto/googleapis/api v0.0.0-20261005182115-fad411399dd8 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20261005182115-fad411399dd8 // indirect
	google.golang.org/grpc v1.84.0 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
	modernc.org/libc v1.75.6 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.12.1 // indirect
)

// Local-encoder demand hook pending upstream #5016; see internal/thirdparty/README.md.
replace github.com/livekit/livekit-server => github.com/TNTcraftHIM/livekit v1.13.11-0.20261015172453-a7c4b2aee315
