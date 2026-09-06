package config

import (
	"fmt"
	"maps"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/TNTcraftHIM/Screener/internal/server/protocol"
)

// Ported from tests/server-config.test.ts.

// env merges the given maps, later keys winning, so a case can extend a base.
func env(parts ...map[string]string) map[string]string {
	merged := map[string]string{}
	for _, part := range parts {
		maps.Copy(merged, part)
	}
	return merged
}

var (
	liveKitAdmission = map[string]string{"LIVEKIT_API_URL": "https://livekit-api.test"}
	liveKitSecret    = strings.Repeat("s", 32)
	productionBase   = map[string]string{
		"SCREENER_ENV":         "production",
		"PUBLIC_BASE_URL":      "https://share.test",
		"SITE_ACCESS_PASSWORD": "host-password-12",
		"STUN_URLS":            "stun:stun.test:3478",
	}
)

func stunList(count int, prefix string) string {
	urls := make([]string, 0, count)
	for index := range count {
		urls = append(urls, fmt.Sprintf("stun:%s-%d.test:3478", prefix, index))
	}
	return strings.Join(urls, ",")
}

func mustLoad(t *testing.T, environment map[string]string) Config {
	t.Helper()
	config, err := Load(environment)
	if err != nil {
		t.Fatalf("Load: unexpected error %v", err)
	}
	return config
}

func TestLoadDevelopmentDefaults(t *testing.T) {
	config := mustLoad(t, map[string]string{"SCREENER_ENV": "development", "PORT": "9123"})

	if config.Env != EnvironmentDevelopment {
		t.Errorf("Env = %q", config.Env)
	}
	if config.ListenHost != "0.0.0.0" {
		t.Errorf("ListenHost = %q", config.ListenHost)
	}
	if got := config.PublicBaseURL.String(); got != "http://localhost:9123/" {
		t.Errorf("PublicBaseURL = %q", got)
	}
	want := map[string]struct{}{"http://localhost:9123": {}}
	if !reflect.DeepEqual(config.AllowedOrigins, want) {
		t.Errorf("AllowedOrigins = %v", config.AllowedOrigins)
	}
	if config.RoomDatabasePath != "" {
		t.Errorf("RoomDatabasePath = %q", config.RoomDatabasePath)
	}
	if len(config.STUNURLs) != 0 {
		t.Errorf("STUNURLs = %v", config.STUNURLs)
	}
	if config.NATPredictionEnabled {
		t.Error("NATPredictionEnabled = true")
	}
	if config.NATPredictionSTUNURLs != nil {
		t.Errorf("NATPredictionSTUNURLs = %v, want nil (TS left it undefined)", config.NATPredictionSTUNURLs)
	}
	if config.MaxViewersPerRoom != 8 {
		t.Errorf("MaxViewersPerRoom = %d", config.MaxViewersPerRoom)
	}
	if config.EndpointMediaCopyCapacity != 2 {
		t.Errorf("EndpointMediaCopyCapacity = %d", config.EndpointMediaCopyCapacity)
	}
	if config.LiveKit != nil {
		t.Errorf("LiveKit = %+v", config.LiveKit)
	}
	if config.RoomLeaseMs != 86_400_000 {
		t.Errorf("RoomLeaseMs = %d", config.RoomLeaseMs)
	}
	if config.SiteAccessPassword != "" {
		t.Error("SiteAccessPassword is set")
	}
}

func TestLoadLiveKitTuple(t *testing.T) {
	config := mustLoad(t, map[string]string{
		"LIVEKIT_URL":        " ws://livekit.test:7880 ",
		"LIVEKIT_API_URL":    " http://livekit.test:7880 ",
		"LIVEKIT_API_KEY":    " test-key ",
		"LIVEKIT_API_SECRET": " " + liveKitSecret + " ",
	})
	want := LiveKitFallback{
		URL:       "ws://livekit.test:7880",
		APIURL:    "http://livekit.test:7880",
		APIKey:    "test-key",
		APISecret: liveKitSecret,
	}
	if config.LiveKit == nil || *config.LiveKit != want {
		t.Errorf("LiveKit = %+v, want %+v", config.LiveKit, want)
	}
}

func TestLoadAccepts(t *testing.T) {
	developmentPath, err := filepath.Abs(filepath.Join("state", "rooms.sqlite"))
	if err != nil {
		t.Fatalf("Abs: %v", err)
	}
	productionPath, err := filepath.Abs(filepath.Join("production-state", "rooms.sqlite"))
	if err != nil {
		t.Fatalf("Abs: %v", err)
	}

	cases := []struct {
		name  string
		env   map[string]string
		check func(*testing.T, Config)
	}{
		{"default viewer limit", map[string]string{}, func(t *testing.T, c Config) {
			if c.MaxViewersPerRoom != 8 {
				t.Errorf("MaxViewersPerRoom = %d", c.MaxViewersPerRoom)
			}
		}},
		{"viewer limit lower boundary", map[string]string{"MAX_VIEWERS_PER_ROOM": "1"},
			func(t *testing.T, c Config) {
				if c.MaxViewersPerRoom != 1 {
					t.Errorf("MaxViewersPerRoom = %d", c.MaxViewersPerRoom)
				}
			}},
		{"viewer limit ceiling",
			map[string]string{"MAX_VIEWERS_PER_ROOM": strconv.Itoa(protocol.MaxViewersPerRoomLimit)},
			func(t *testing.T, c Config) {
				if c.MaxViewersPerRoom != protocol.MaxViewersPerRoomLimit {
					t.Errorf("MaxViewersPerRoom = %d", c.MaxViewersPerRoom)
				}
			}},
		{"copy capacity 1", map[string]string{"ENDPOINT_MEDIA_COPY_CAPACITY": "1"},
			func(t *testing.T, c Config) {
				if c.EndpointMediaCopyCapacity != 1 {
					t.Errorf("EndpointMediaCopyCapacity = %d", c.EndpointMediaCopyCapacity)
				}
			}},
		{"copy capacity 2", map[string]string{"ENDPOINT_MEDIA_COPY_CAPACITY": "2"},
			func(t *testing.T, c Config) {
				if c.EndpointMediaCopyCapacity != 2 {
					t.Errorf("EndpointMediaCopyCapacity = %d", c.EndpointMediaCopyCapacity)
				}
			}},
		{"copy capacity 3", map[string]string{"ENDPOINT_MEDIA_COPY_CAPACITY": "3"},
			func(t *testing.T, c Config) {
				if c.EndpointMediaCopyCapacity != 3 {
					t.Errorf("EndpointMediaCopyCapacity = %d", c.EndpointMediaCopyCapacity)
				}
			}},
		{"explicit loopback listen host", map[string]string{"LISTEN_HOST": " 127.0.0.1 "},
			func(t *testing.T, c Config) {
				if c.ListenHost != "127.0.0.1" {
					t.Errorf("ListenHost = %q", c.ListenHost)
				}
			}},
		{"production STUN", productionBase, func(t *testing.T, c Config) {
			if !slices.Equal(c.STUNURLs, []string{"stun:stun.test:3478"}) {
				t.Errorf("STUNURLs = %v", c.STUNURLs)
			}
		}},
		{"production site access password",
			env(productionBase, map[string]string{"SITE_ACCESS_PASSWORD": "easy-key"}),
			func(t *testing.T, c Config) {
				if c.SiteAccessPassword != "easy-key" {
					t.Errorf("SiteAccessPassword = %q", c.SiteAccessPassword)
				}
			}},
		{"STUN-only production with LiveKit", env(productionBase, liveKitAdmission, map[string]string{
			"LIVEKIT_URL":        "wss://livekit.test",
			"LIVEKIT_API_KEY":    "test-key",
			"LIVEKIT_API_SECRET": liveKitSecret,
		}), func(t *testing.T, c Config) {
			if c.LiveKit == nil || c.LiveKit.URL != "wss://livekit.test" {
				t.Errorf("LiveKit = %+v", c.LiveKit)
			}
		}},
		{"production loopback LiveKit control", env(productionBase, map[string]string{
			"LIVEKIT_URL":        "wss://livekit.test",
			"LIVEKIT_API_URL":    "http://127.0.0.1:7880",
			"LIVEKIT_API_KEY":    "test-key",
			"LIVEKIT_API_SECRET": liveKitSecret,
		}), func(t *testing.T, c Config) {
			if c.LiveKit == nil || c.LiveKit.APIURL != "http://127.0.0.1:7880" {
				t.Errorf("LiveKit = %+v", c.LiveKit)
			}
		}},
		{"uppercase STUN scheme and IPv6 host", map[string]string{"STUN_URLS": "STUN:[2001:db8::1]:3478"},
			func(t *testing.T, c Config) {
				if !slices.Equal(c.STUNURLs, []string{"STUN:[2001:db8::1]:3478"}) {
					t.Errorf("STUNURLs = %v", c.STUNURLs)
				}
			}},
		{"NAT prediction with a base listener", map[string]string{
			"STUN_URLS":              "stun:share.test:3478",
			"NAT_PREDICTION_ENABLED": "true",
		}, func(t *testing.T, c Config) {
			if !c.NATPredictionEnabled {
				t.Error("NATPredictionEnabled = false")
			}
		}},
		{"room lease default", map[string]string{}, func(t *testing.T, c Config) {
			if c.RoomLeaseMs != 86_400_000 {
				t.Errorf("RoomLeaseMs = %d", c.RoomLeaseMs)
			}
		}},
		{"room lease override", map[string]string{"ROOM_LEASE_SECONDS": "3600"},
			func(t *testing.T, c Config) {
				if c.RoomLeaseMs != 3_600_000 {
					t.Errorf("RoomLeaseMs = %d", c.RoomLeaseMs)
				}
			}},
		{"file-backed room authority in development",
			map[string]string{"ROOM_DATABASE_PATH": " " + developmentPath + " "},
			func(t *testing.T, c Config) {
				if c.RoomDatabasePath != developmentPath {
					t.Errorf("RoomDatabasePath = %q", c.RoomDatabasePath)
				}
			}},
		{"blank room database path", map[string]string{"ROOM_DATABASE_PATH": ""},
			func(t *testing.T, c Config) {
				if c.RoomDatabasePath != "" {
					t.Errorf("RoomDatabasePath = %q", c.RoomDatabasePath)
				}
			}},
		{"file-backed room authority in production",
			env(productionBase, map[string]string{"ROOM_DATABASE_PATH": productionPath}),
			func(t *testing.T, c Config) {
				if c.RoomDatabasePath != productionPath {
					t.Errorf("RoomDatabasePath = %q", c.RoomDatabasePath)
				}
			}},
		{"allowed origins are normalised",
			map[string]string{"ALLOWED_ORIGINS": " https://Example.com:443/path , http://a.test:80 "},
			func(t *testing.T, c Config) {
				want := map[string]struct{}{"https://example.com": {}, "http://a.test": {}}
				if !reflect.DeepEqual(c.AllowedOrigins, want) {
					t.Errorf("AllowedOrigins = %v", c.AllowedOrigins)
				}
			}},
		// Number(string) coercion, which the TS parsers inherited.
		{"port with surrounding whitespace", map[string]string{"PORT": " 9123 "},
			func(t *testing.T, c Config) {
				if c.Port != 9123 {
					t.Errorf("Port = %d", c.Port)
				}
			}},
		{"hexadecimal port", map[string]string{"PORT": "0x1F5B"}, func(t *testing.T, c Config) {
			if c.Port != 8027 {
				t.Errorf("Port = %d", c.Port)
			}
		}},
		{"exponent room lease", map[string]string{"ROOM_LEASE_SECONDS": "1e3"},
			func(t *testing.T, c Config) {
				if c.RoomLeaseMs != 1_000_000 {
					t.Errorf("RoomLeaseMs = %d", c.RoomLeaseMs)
				}
			}},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			testCase.check(t, mustLoad(t, testCase.env))
		})
	}
}

func TestLoadRejects(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want string
	}{
		// Partial LiveKit credential tuples.
		{"only LiveKit URL", map[string]string{"LIVEKIT_URL": "wss://livekit.test"},
			"LIVEKIT_URL, LIVEKIT_API_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be configured together"},
		{"only LiveKit control URL", liveKitAdmission,
			"LIVEKIT_URL, LIVEKIT_API_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be configured together"},
		{"only LiveKit key", map[string]string{"LIVEKIT_API_KEY": "test-key"},
			"must be configured together"},
		{"only LiveKit secret", map[string]string{"LIVEKIT_API_SECRET": liveKitSecret},
			"must be configured together"},
		{"LiveKit without secret", env(liveKitAdmission, map[string]string{
			"LIVEKIT_URL": "wss://livekit.test", "LIVEKIT_API_KEY": "test-key",
		}), "must be configured together"},

		// Invalid LiveKit media origins.
		{"LiveKit https scheme", liveKitURL("https://livekit.test"), "LIVEKIT_URL must use ws or wss"},
		{"LiveKit credentials", liveKitURL("wss://user:pass@livekit.test"),
			"LIVEKIT_URL must be an origin without credentials, path, query, or fragment"},
		{"LiveKit path", liveKitURL("wss://livekit.test/rtc"), "LIVEKIT_URL must be an origin"},
		{"LiveKit query", liveKitURL("wss://livekit.test?token=value"), "LIVEKIT_URL must be an origin"},
		{"LiveKit fragment", liveKitURL("wss://livekit.test#fragment"), "LIVEKIT_URL must be an origin"},
		{"LiveKit not a URL", liveKitURL("livekit.test"), "LIVEKIT_URL must be a valid ws or wss origin"},
		{"LiveKit ws in production", env(productionBase, liveKitAdmission, map[string]string{
			"LIVEKIT_URL": "ws://livekit.test:7880", "LIVEKIT_API_KEY": "test-key",
			"LIVEKIT_API_SECRET": liveKitSecret,
		}), "LIVEKIT_URL must use wss in production"},

		// Invalid LiveKit control origins.
		{"control ws scheme", liveKitAPIURL("ws://livekit-api.test"), "LIVEKIT_API_URL must use http or https"},
		{"control credentials", liveKitAPIURL("http://user:pass@livekit-api.test"),
			"LIVEKIT_API_URL must be an origin without credentials, path, query, or fragment"},
		{"control path", liveKitAPIURL("http://livekit-api.test/rtc"), "LIVEKIT_API_URL must be an origin"},
		{"control query", liveKitAPIURL("http://livekit-api.test?token=value"), "LIVEKIT_API_URL must be an origin"},
		{"control fragment", liveKitAPIURL("http://livekit-api.test#fragment"), "LIVEKIT_API_URL must be an origin"},
		{"control not a URL", liveKitAPIURL("livekit-api.test"),
			"LIVEKIT_API_URL must be a valid http or https origin"},
		{"control plaintext in production", env(productionBase, map[string]string{
			"LIVEKIT_URL": "wss://livekit.test", "LIVEKIT_API_URL": "http://livekit-api.test:7880",
			"LIVEKIT_API_KEY": "test-key", "LIVEKIT_API_SECRET": liveKitSecret,
		}), "must use https or loopback"},
		{"short LiveKit secret", env(liveKitAdmission, map[string]string{
			"LIVEKIT_URL": "wss://livekit.test", "LIVEKIT_API_KEY": "test-key",
			"LIVEKIT_API_SECRET": "too-short",
		}), "LIVEKIT_API_SECRET must contain at least 32 bytes"},

		// Reused infrastructure secrets.
		{"site password reused as LiveKit secret", env(liveKitAdmission, map[string]string{
			"SITE_ACCESS_PASSWORD": strings.Repeat("x", 32), "LIVEKIT_URL": "wss://livekit.test",
			"LIVEKIT_API_KEY": "test-key", "LIVEKIT_API_SECRET": strings.Repeat("x", 32),
		}), "must use independent values"},
		{"LiveKit key reused as LiveKit secret", env(liveKitAdmission, map[string]string{
			"LIVEKIT_URL": "wss://livekit.test", "LIVEKIT_API_KEY": strings.Repeat("x", 32),
			"LIVEKIT_API_SECRET": strings.Repeat("x", 32),
		}), "must use independent values"},

		// Bounded integers.
		{"viewer limit above ceiling",
			map[string]string{"MAX_VIEWERS_PER_ROOM": strconv.Itoa(protocol.MaxViewersPerRoomLimit + 1)},
			"MAX_VIEWERS_PER_ROOM must be between 1 and 20"},
		{"viewer limit zero", map[string]string{"MAX_VIEWERS_PER_ROOM": "0"},
			"MAX_VIEWERS_PER_ROOM must be a positive integer"},
		{"fractional viewer limit", map[string]string{"MAX_VIEWERS_PER_ROOM": "1.5"},
			"MAX_VIEWERS_PER_ROOM must be a positive integer"},
		{"copy capacity zero", map[string]string{"ENDPOINT_MEDIA_COPY_CAPACITY": "0"},
			"ENDPOINT_MEDIA_COPY_CAPACITY must be a positive integer"},
		{"copy capacity above ceiling", map[string]string{"ENDPOINT_MEDIA_COPY_CAPACITY": "4"},
			"ENDPOINT_MEDIA_COPY_CAPACITY must be between 1 and 3"},
		{"fractional copy capacity", map[string]string{"ENDPOINT_MEDIA_COPY_CAPACITY": "1.5"},
			"ENDPOINT_MEDIA_COPY_CAPACITY must be a positive integer"},
		{"zero room lease", map[string]string{"ROOM_LEASE_SECONDS": "0"},
			"ROOM_LEASE_SECONDS must be a positive integer"},
		{"port zero", map[string]string{"PORT": "0"}, "PORT must be a positive integer"},
		{"port not a number", map[string]string{"PORT": "eight"}, "PORT must be a positive integer"},
		{"port above the TCP ceiling", map[string]string{"PORT": "65536"}, "PORT must be at most 65535"},

		// Public base URL.
		{"public base URL credentials", map[string]string{"PUBLIC_BASE_URL": "https://user:pass@share.test"},
			"PUBLIC_BASE_URL must be an origin"},
		{"public base URL path", map[string]string{"PUBLIC_BASE_URL": "https://share.test/path"},
			"PUBLIC_BASE_URL must be an origin"},
		{"public base URL query", map[string]string{"PUBLIC_BASE_URL": "https://share.test?query=1"},
			"PUBLIC_BASE_URL must be an origin"},
		{"public base URL fragment", map[string]string{"PUBLIC_BASE_URL": "https://share.test#fragment"},
			"PUBLIC_BASE_URL must be an origin"},
		{"public base URL scheme", map[string]string{"PUBLIC_BASE_URL": "ftp://share.test"},
			"PUBLIC_BASE_URL must use http or https"},
		{"blank public base URL", map[string]string{"PUBLIC_BASE_URL": ""},
			"PUBLIC_BASE_URL must be a valid http or https origin"},
		{"plaintext public base URL in production", env(productionBase, map[string]string{
			"PUBLIC_BASE_URL": "http://share.test",
		}), "PUBLIC_BASE_URL must use https in production"},

		// Allowed origins.
		{"allowed origin scheme", map[string]string{"ALLOWED_ORIGINS": "ftp://share.test"},
			"Allowed origins must use http or https"},
		{"unparsable allowed origin", map[string]string{"ALLOWED_ORIGINS": "share.test"},
			"Allowed origins must be valid http or https URLs"},
		{"empty allowed origin entry", map[string]string{"ALLOWED_ORIGINS": "https://a.test,,https://b.test"},
			"ALLOWED_ORIGINS contains an empty URL"},

		// Production requirements.
		{"production without STUN", map[string]string{
			"SCREENER_ENV": "production", "PUBLIC_BASE_URL": "https://share.test",
			"SITE_ACCESS_PASSWORD": "host-password-12",
		}, "STUN is required in production"},
		{"production without a site password", map[string]string{
			"SCREENER_ENV": "production", "PUBLIC_BASE_URL": "https://share.test",
			"STUN_URLS": "stun:stun.test:3478",
		}, "SITE_ACCESS_PASSWORD is required in production"},

		// Site access password bounds (UTF-8 bytes).
		{"site password too short", map[string]string{"SITE_ACCESS_PASSWORD": strings.Repeat("x", 7)},
			"SITE_ACCESS_PASSWORD must contain 8 to 128 visible ASCII bytes"},
		{"site password outside ASCII", map[string]string{"SITE_ACCESS_PASSWORD": "密码密码密码密码"},
			"SITE_ACCESS_PASSWORD must contain 8 to 128 visible ASCII bytes"},
		{"site password with spaces", map[string]string{"SITE_ACCESS_PASSWORD": "contains spaces"},
			"SITE_ACCESS_PASSWORD must contain 8 to 128 visible ASCII bytes"},
		{"site password too long", map[string]string{"SITE_ACCESS_PASSWORD": strings.Repeat("x", 129)},
			"SITE_ACCESS_PASSWORD must contain 8 to 128 visible ASCII bytes"},

		// STUN lists.
		{"STUN path", map[string]string{"STUN_URLS": "stun:stun.test/path"},
			"STUN_URLS contains an invalid STUN URL"},
		{"STUN query", map[string]string{"STUN_URLS": "stun:stun.test?transport=udp"},
			"STUN_URLS contains an invalid STUN URL"},
		{"STUN fragment", map[string]string{"STUN_URLS": "stun:stun.test#fragment"},
			"STUN_URLS contains an invalid STUN URL"},
		{"STUN without authority", map[string]string{"STUN_URLS": "stun:"},
			"STUN_URLS contains an invalid STUN URL"},
		{"STUN with an empty port", map[string]string{"STUN_URLS": "stun:stun.test:"},
			"STUN_URLS contains an invalid STUN URL"},
		{"STUN port zero", map[string]string{"STUN_URLS": "stun:stun.test:0"},
			"STUN_URLS contains an invalid STUN URL"},
		{"STUN userinfo", map[string]string{"STUN_URLS": "stun:user@stun.test:3478"},
			"STUN_URLS contains an invalid STUN URL"},
		{"TURN scheme", map[string]string{"STUN_URLS": "turn:turn.test:3478"},
			"STUN_URLS contains an invalid STUN URL"},
		{"STUNS scheme", map[string]string{"STUN_URLS": "stuns:stun.test:5349"},
			"STUN_URLS contains an invalid STUN URL"},
		{"empty STUN entry", map[string]string{"STUN_URLS": "stun:a.test:3478,,stun:b.test:3478"},
			"STUN_URLS contains an empty URL"},
		{"too many STUN URLs", map[string]string{"STUN_URLS": stunList(9, "stun")},
			"STUN_URLS must contain at most 8 URLs"},
		{"no NAT prediction slots", map[string]string{
			"STUN_URLS": stunList(7, "ordinary"), "NAT_PREDICTION_ENABLED": "true",
		}, "STUN_URLS must contain at most 6 URLs when NAT_PREDICTION_ENABLED=true"},

		// NAT prediction.
		{"NAT prediction without STUN", map[string]string{"NAT_PREDICTION_ENABLED": "true"},
			"NAT_PREDICTION_ENABLED requires a STUN_URLS entry on UDP 3478"},
		{"NAT prediction off the base port", map[string]string{
			"STUN_URLS": "stun:share.test:5349", "NAT_PREDICTION_ENABLED": "true",
		}, "NAT_PREDICTION_ENABLED requires a STUN_URLS entry on UDP 3478"},
		{"NAT prediction not a boolean", map[string]string{"NAT_PREDICTION_ENABLED": "sometimes"},
			"NAT_PREDICTION_ENABLED must be true or false"},

		// Room database path.
		{"memory room database path", map[string]string{"ROOM_DATABASE_PATH": ":memory:"},
			"ROOM_DATABASE_PATH must be an absolute file path"},
		{"room database path with a NUL", map[string]string{"ROOM_DATABASE_PATH": "rooms\x00.sqlite"},
			"ROOM_DATABASE_PATH must be an absolute file path"},
		{"bare room database file name", map[string]string{"ROOM_DATABASE_PATH": "rooms.sqlite"},
			"ROOM_DATABASE_PATH must be an absolute file path"},
		{"relative room database path", map[string]string{"ROOM_DATABASE_PATH": "./state/rooms.sqlite"},
			"ROOM_DATABASE_PATH must be an absolute file path"},

		// Runtime environment (DECISIONS D8).
		{"NODE_ENV is removed", map[string]string{"NODE_ENV": "production"},
			"NODE_ENV is no longer supported; use SCREENER_ENV"},
		{"blank NODE_ENV is removed", map[string]string{"NODE_ENV": ""},
			"NODE_ENV is no longer supported; use SCREENER_ENV"},
		{"test environment is gone", map[string]string{"SCREENER_ENV": "test"},
			"SCREENER_ENV must be development or production"},
		{"blank environment", map[string]string{"SCREENER_ENV": ""},
			"SCREENER_ENV must be development or production"},

		// Removed variables carrying their own replacement.
		{"removed relay downstream setting", map[string]string{"MAX_PEER_RELAY_DOWNSTREAM_EDGES": "2"},
			"MAX_PEER_RELAY_DOWNSTREAM_EDGES is no longer supported; use ENDPOINT_MEDIA_COPY_CAPACITY"},
		{"removed room rollout setting", map[string]string{"PEER_ASSISTED_ROOM_IDS": "1"},
			"PEER_ASSISTED_ROOM_IDS is no longer supported; peer-assisted media applies to every room"},
		{"removed peer-assisted toggle", map[string]string{"PEER_ASSISTED_MEDIA": "true"},
			"PEER_ASSISTED_MEDIA is no longer supported; peer-assisted media is always enabled"},
		{"removed room TTL", map[string]string{"ROOM_TTL_SECONDS": ""},
			"ROOM_TTL_SECONDS is no longer supported; use ROOM_LEASE_SECONDS"},
		{"removed access password", map[string]string{"ACCESS_PASSWORD": "legacy-password"},
			"ACCESS_PASSWORD is no longer supported; use SITE_ACCESS_PASSWORD"},
		{"blank access password", map[string]string{"ACCESS_PASSWORD": ""},
			"ACCESS_PASSWORD is no longer supported; use SITE_ACCESS_PASSWORD"},
		{"removed host admission password", map[string]string{"HOST_ADMISSION_PASSWORD": "legacy-password"},
			"HOST_ADMISSION_PASSWORD is no longer supported; use SITE_ACCESS_PASSWORD"},
		{"blank host admission password", map[string]string{"HOST_ADMISSION_PASSWORD": ""},
			"HOST_ADMISSION_PASSWORD is no longer supported; use SITE_ACCESS_PASSWORD"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := Load(testCase.env)
			if err == nil {
				t.Fatalf("Load: want error containing %q", testCase.want)
			}
			if !strings.Contains(err.Error(), testCase.want) {
				t.Errorf("Load: error %q, want it to contain %q", err, testCase.want)
			}
		})
	}
}

// TestLoadRejectsRemovedTurnVariables covers the ten TURN names that share the
// default reason, blank included.
func TestLoadRejectsRemovedTurnVariables(t *testing.T) {
	names := []string{
		"TURN_URLS", "TURN_SHARED_SECRET", "TURN_CREDENTIAL_TTL_SECONDS",
		"PEER_ICE_TURN_URLS", "PEER_ICE_TURN_SHARED_SECRET",
		"PEER_ICE_TURN_CREDENTIAL_TTL_SECONDS", "SELECTED_EDGE_TURN_URLS",
		"SELECTED_EDGE_TURN_SHARED_SECRET", "SELECTED_EDGE_TURN_CREDENTIAL_TTL_SECONDS",
		"SELECTED_EDGE_TURN_ALLOCATION_CAPACITY",
	}
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			_, err := Load(map[string]string{name: ""})
			want := name + " is no longer supported; ordinary ICE accepts STUN_URLS only"
			if err == nil || err.Error() != want {
				t.Errorf("Load: error %v, want %q", err, want)
			}
		})
	}
}

func TestOrigin(t *testing.T) {
	cases := []struct{ raw, scheme, alternative, want string }{
		{"https://Example.com:443/", "http", "https", "https://example.com"},
		{"http://Example.com:80", "http", "https", "http://example.com"},
		{"https://share.test:0443", "http", "https", "https://share.test"},
		{"http://localhost:9123", "http", "https", "http://localhost:9123"},
		{"wss://LiveKit.test:443", "ws", "wss", "wss://livekit.test"},
		{"ws://livekit.test:7880", "ws", "wss", "ws://livekit.test:7880"},
		{"https://[2001:DB8::1]:8443", "http", "https", "https://[2001:db8::1]:8443"},
		{"http://[::1]:7880", "http", "https", "http://[::1]:7880"},
	}
	for _, testCase := range cases {
		t.Run(testCase.raw, func(t *testing.T) {
			parsed, err := parseOriginURL(testCase.raw, "TEST", testCase.scheme, testCase.alternative)
			if err != nil {
				t.Fatalf("parseOriginURL: %v", err)
			}
			if got := Origin(parsed); got != testCase.want {
				t.Errorf("Origin = %q, want %q", got, testCase.want)
			}
			if got := parsed.String(); got != testCase.want+"/" {
				t.Errorf("String = %q, want %q", got, testCase.want+"/")
			}
		})
	}
}

func liveKitURL(value string) map[string]string {
	return env(liveKitAdmission, map[string]string{
		"LIVEKIT_URL": value, "LIVEKIT_API_KEY": "test-key", "LIVEKIT_API_SECRET": liveKitSecret,
	})
}

func liveKitAPIURL(value string) map[string]string {
	return map[string]string{
		"LIVEKIT_URL": "wss://livekit.test", "LIVEKIT_API_URL": value,
		"LIVEKIT_API_KEY": "test-key", "LIVEKIT_API_SECRET": liveKitSecret,
	}
}
