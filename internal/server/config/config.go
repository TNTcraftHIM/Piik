// Package config ports src/server/config.ts, src/server/local-config.ts and
// src/server/ice.ts: the Hosted environment contract, the Client's local
// composition, and the ICE configuration derived from either. It performs no
// I/O; the caller supplies the environment as a map.
package config

import (
	"errors"
	"fmt"
	"math"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/TNTcraftHIM/Screener/internal/server/protocol"
)

// Environment ports RuntimeEnvironment. DECISIONS D8 renames NODE_ENV to
// SCREENER_ENV and drops "test".
type Environment string

// The two accepted SCREENER_ENV values.
const (
	EnvironmentDevelopment Environment = "development"
	EnvironmentProduction  Environment = "production"
)

// Bounds and defaults from src/server/config.ts.
const (
	minSiteAccessPasswordBytes = 8
	maxSiteAccessPasswordBytes = 128
	minLiveKitAPISecretBytes   = 32
	defaultMaxViewersPerRoom   = 8
	defaultRoomLeaseSeconds    = 86_400
	defaultPort                = 8787
	maxPort                    = 65_535
)

// VISIBLE_ASCII_PATTERN.
var visibleASCIIPattern = regexp.MustCompile(`^[\x21-\x7e]+$`)

const removedTurnReason = "ordinary ICE accepts STUN_URLS only"

// removedEnvironmentVariables ports REMOVED_ENVIRONMENT_VARIABLES together with
// the two names the TypeScript checked separately, and NODE_ENV (DECISIONS D8:
// a stale unit file must not fail open). An empty reason takes the TURN default.
// The order is the report order when several removed names are present.
var removedEnvironmentVariables = []struct{ name, reason string }{
	{"TURN_URLS", ""},
	{"TURN_SHARED_SECRET", ""},
	{"TURN_CREDENTIAL_TTL_SECONDS", ""},
	{"PEER_ICE_TURN_URLS", ""},
	{"PEER_ICE_TURN_SHARED_SECRET", ""},
	{"PEER_ICE_TURN_CREDENTIAL_TTL_SECONDS", ""},
	{"SELECTED_EDGE_TURN_URLS", ""},
	{"SELECTED_EDGE_TURN_SHARED_SECRET", ""},
	{"SELECTED_EDGE_TURN_CREDENTIAL_TTL_SECONDS", ""},
	{"SELECTED_EDGE_TURN_ALLOCATION_CAPACITY", ""},
	{"PEER_ASSISTED_ROOM_IDS", "peer-assisted media applies to every room"},
	{"PEER_ASSISTED_MEDIA", "peer-assisted media is always enabled"},
	{"HOST_ADMISSION_PASSWORD", "use SITE_ACCESS_PASSWORD"},
	{"MAX_PEER_RELAY_DOWNSTREAM_EDGES", "use ENDPOINT_MEDIA_COPY_CAPACITY"},
	{"ROOM_TTL_SECONDS", "use ROOM_LEASE_SECONDS"},
	{"ACCESS_PASSWORD", "use SITE_ACCESS_PASSWORD"},
	{"NODE_ENV", "use SCREENER_ENV"},
}

// LiveKitFallback ports LiveKitFallbackConfig. URL and APIURL are serialised
// WHATWG origins.
type LiveKitFallback struct {
	URL       string
	APIURL    string
	APIKey    string
	APISecret string
}

// Config ports ServerConfig. Fields the TypeScript left `undefined` are the
// zero value here: an empty SiteAccessPassword means site access is open, an
// empty RoomDatabasePath means memory mode, and a nil LiveKit means no SFU
// fallback.
type Config struct {
	Env           Environment
	Port          int
	ListenHost    string
	PublicBaseURL *url.URL
	// AllowedOrigins is a membership test only; Go map order is not observable
	// here (src/server/app.ts only ever calls `allowedOrigins.has(origin)`).
	AllowedOrigins            map[string]struct{}
	SiteAccessPassword        string
	RoomDatabasePath          string
	RoomLeaseMs               int64
	MaxViewersPerRoom         int
	EndpointMediaCopyCapacity int
	LiveKit                   *LiveKitFallback
	STUNURLs                  []string
	NATPredictionEnabled      bool
	// NATPredictionSTUNURLs is nil where the TypeScript left it `undefined`,
	// which IceConfig distinguishes from a configured empty list.
	NATPredictionSTUNURLs []string
}

// Load ports loadConfig. env is the whole process environment: cmd passes
// os.Environ() as a map, tests pass a literal. A key present with an empty
// value is `""` in TypeScript too, so presence is the only distinction that
// needs the two-value lookup.
func Load(env map[string]string) (Config, error) {
	for _, removed := range removedEnvironmentVariables {
		if _, present := env[removed.name]; present {
			reason := removed.reason
			if reason == "" {
				reason = removedTurnReason
			}
			return Config{}, fmt.Errorf("%s is no longer supported; %s", removed.name, reason)
		}
	}

	environment, err := parseEnvironment(env)
	if err != nil {
		return Config{}, err
	}
	port, err := parsePositiveInteger(env["PORT"], defaultPort, "PORT")
	if err != nil {
		return Config{}, err
	}
	if port > maxPort {
		return Config{}, fmt.Errorf("PORT must be at most %d", maxPort)
	}
	listenHost := strings.TrimFunc(env["LISTEN_HOST"], protocol.IsJSWhitespace)
	if listenHost == "" {
		listenHost = "0.0.0.0"
	}

	// TS: environment.PUBLIC_BASE_URL ?? `http://localhost:${port}` — only an
	// absent variable takes the default.
	rawPublicBaseURL, present := env["PUBLIC_BASE_URL"]
	if !present {
		rawPublicBaseURL = fmt.Sprintf("http://localhost:%d", port)
	}
	publicBaseURL, err := parseOriginURL(rawPublicBaseURL, "PUBLIC_BASE_URL", "http", "https")
	if err != nil {
		return Config{}, err
	}
	if environment == EnvironmentProduction && publicBaseURL.Scheme != "https" {
		return Config{}, errors.New("PUBLIC_BASE_URL must use https in production")
	}

	siteAccessPassword := env["SITE_ACCESS_PASSWORD"]
	roomDatabasePath, err := parseRoomDatabasePath(env["ROOM_DATABASE_PATH"])
	if err != nil {
		return Config{}, err
	}
	stunURLs, err := parseStunURLList(env["STUN_URLS"], "STUN_URLS")
	if err != nil {
		return Config{}, err
	}
	natPredictionEnabled, err := parseBoolean(env["NAT_PREDICTION_ENABLED"], "NAT_PREDICTION_ENABLED")
	if err != nil {
		return Config{}, err
	}
	if natPredictionEnabled && len(NATPredictionStunURLs(stunURLs)) == 0 {
		return Config{}, errors.New("NAT_PREDICTION_ENABLED requires a STUN_URLS entry on UDP 3478")
	}
	if natPredictionEnabled &&
		len(stunURLs)+protocol.MaxNatPredictionAuxiliaryStunURLs > protocol.MaxIceServerURLs {
		return Config{}, fmt.Errorf(
			"STUN_URLS must contain at most %d URLs when NAT_PREDICTION_ENABLED=true",
			protocol.MaxIceServerURLs-protocol.MaxNatPredictionAuxiliaryStunURLs)
	}
	maxViewersPerRoom, err := parseBoundedInteger(env["MAX_VIEWERS_PER_ROOM"],
		defaultMaxViewersPerRoom, "MAX_VIEWERS_PER_ROOM", 1, protocol.MaxViewersPerRoomLimit)
	if err != nil {
		return Config{}, err
	}
	endpointMediaCopyCapacity, err := parseBoundedInteger(env["ENDPOINT_MEDIA_COPY_CAPACITY"],
		protocol.DefaultEndpointMediaCopyCapacity, "ENDPOINT_MEDIA_COPY_CAPACITY",
		1, protocol.MaxEndpointMediaCopyCapacity)
	if err != nil {
		return Config{}, err
	}
	liveKit, err := parseLiveKitFallback(env, environment)
	if err != nil {
		return Config{}, err
	}

	secrets := make([]string, 0, 3)
	if siteAccessPassword != "" {
		secrets = append(secrets, siteAccessPassword)
	}
	if liveKit != nil {
		secrets = append(secrets, liveKit.APIKey, liveKit.APISecret)
	}
	distinct := make(map[string]struct{}, len(secrets))
	for _, secret := range secrets {
		distinct[secret] = struct{}{}
	}
	if len(distinct) != len(secrets) {
		return Config{}, errors.New(
			"SITE_ACCESS_PASSWORD, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must use independent values")
	}
	// Buffer.byteLength is the UTF-8 length, which is len() in Go. The pattern
	// already restricts the value to one byte per character.
	if siteAccessPassword != "" &&
		(!visibleASCIIPattern.MatchString(siteAccessPassword) ||
			len(siteAccessPassword) < minSiteAccessPasswordBytes ||
			len(siteAccessPassword) > maxSiteAccessPasswordBytes) {
		return Config{}, fmt.Errorf("SITE_ACCESS_PASSWORD must contain %d to %d visible ASCII bytes",
			minSiteAccessPasswordBytes, maxSiteAccessPasswordBytes)
	}
	if environment == EnvironmentProduction && siteAccessPassword == "" {
		return Config{}, errors.New("SITE_ACCESS_PASSWORD is required in production")
	}
	if environment == EnvironmentProduction && len(stunURLs) == 0 {
		return Config{}, errors.New("STUN is required in production")
	}

	// ALLOWED_ORIGINS and ROOM_LEASE_SECONDS are validated inside the returned
	// object literal, i.e. after every check above; keep that order.
	allowedOrigins, err := parseOrigins(env["ALLOWED_ORIGINS"], Origin(publicBaseURL))
	if err != nil {
		return Config{}, err
	}
	roomLeaseSeconds, err := parsePositiveInteger(env["ROOM_LEASE_SECONDS"],
		defaultRoomLeaseSeconds, "ROOM_LEASE_SECONDS")
	if err != nil {
		return Config{}, err
	}

	return Config{
		Env:                       environment,
		Port:                      int(port),
		ListenHost:                listenHost,
		PublicBaseURL:             publicBaseURL,
		AllowedOrigins:            allowedOrigins,
		SiteAccessPassword:        siteAccessPassword,
		RoomDatabasePath:          roomDatabasePath,
		RoomLeaseMs:               roomLeaseSeconds * 1_000,
		MaxViewersPerRoom:         int(maxViewersPerRoom),
		EndpointMediaCopyCapacity: int(endpointMediaCopyCapacity),
		LiveKit:                   liveKit,
		STUNURLs:                  stunURLs,
		NATPredictionEnabled:      natPredictionEnabled,
	}, nil
}

// parseEnvironment ports parseEnvironment for SCREENER_ENV.
func parseEnvironment(env map[string]string) (Environment, error) {
	// TS: value ?? "development" — a present empty value is not nullish and so
	// reaches the check below.
	value, present := env["SCREENER_ENV"]
	if !present {
		return EnvironmentDevelopment, nil
	}
	switch Environment(value) {
	case EnvironmentDevelopment, EnvironmentProduction:
		return Environment(value), nil
	}
	return "", errors.New("SCREENER_ENV must be development or production")
}

// parseBoolean ports parseBoolean; every caller used a false fallback.
func parseBoolean(value string, name string) (bool, error) {
	switch value {
	case "", "false":
		return false, nil
	case "true":
		return true, nil
	}
	return false, fmt.Errorf("%s must be true or false", name)
}

// parsePositiveInteger ports parsePositiveInteger, including Number.isSafeInteger.
func parsePositiveInteger(value string, fallback int64, name string) (int64, error) {
	if value == "" {
		return fallback, nil
	}
	number, ok := jsNumber(value)
	if !ok || number != math.Trunc(number) || number <= 0 || number > protocol.MaxSafeInteger {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return int64(number), nil
}

// parseBoundedInteger ports parseBoundedInteger.
func parseBoundedInteger(value string, fallback int64, name string, minimum, maximum int64) (int64, error) {
	parsed, err := parsePositiveInteger(value, fallback, name)
	if err != nil {
		return 0, err
	}
	if parsed < minimum || parsed > maximum {
		return 0, fmt.Errorf("%s must be between %d and %d", name, minimum, maximum)
	}
	return parsed, nil
}

// parseRoomDatabasePath ports parseRoomDatabasePath. DECISIONS D8: absoluteness
// is filepath.IsAbs, which differs from Node's path.isAbsolute on Windows,
// where "/var/lib/screener/rooms.sqlite" is relative to the current volume and
// is therefore rejected here. Hosted runs on Linux.
func parseRoomDatabasePath(value string) (string, error) {
	path := strings.TrimFunc(value, protocol.IsJSWhitespace)
	if path == "" {
		return "", nil
	}
	if path == ":memory:" || strings.ContainsRune(path, 0) || !filepath.IsAbs(path) {
		return "", errors.New("ROOM_DATABASE_PATH must be an absolute file path")
	}
	return path, nil
}

// parseLiveKitFallback ports parseLiveKitFallback.
func parseLiveKitFallback(env map[string]string, environment Environment) (*LiveKitFallback, error) {
	rawURL := strings.TrimFunc(env["LIVEKIT_URL"], protocol.IsJSWhitespace)
	rawAPIURL := strings.TrimFunc(env["LIVEKIT_API_URL"], protocol.IsJSWhitespace)
	apiKey := strings.TrimFunc(env["LIVEKIT_API_KEY"], protocol.IsJSWhitespace)
	apiSecret := strings.TrimFunc(env["LIVEKIT_API_SECRET"], protocol.IsJSWhitespace)

	configured := 0
	for _, value := range []string{rawURL, rawAPIURL, apiKey, apiSecret} {
		if value != "" {
			configured++
		}
	}
	if configured == 0 {
		return nil, nil
	}
	if configured != 4 {
		return nil, errors.New(
			"LIVEKIT_URL, LIVEKIT_API_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be configured together")
	}
	if len(apiSecret) < minLiveKitAPISecretBytes {
		return nil, fmt.Errorf("LIVEKIT_API_SECRET must contain at least %d bytes", minLiveKitAPISecretBytes)
	}

	parsedURL, err := parseOriginURL(rawURL, "LIVEKIT_URL", "ws", "wss")
	if err != nil {
		return nil, err
	}
	if environment == EnvironmentProduction && parsedURL.Scheme != "wss" {
		return nil, errors.New("LIVEKIT_URL must use wss in production")
	}
	parsedAPIURL, err := parseOriginURL(rawAPIURL, "LIVEKIT_API_URL", "http", "https")
	if err != nil {
		return nil, err
	}
	if environment == EnvironmentProduction && parsedAPIURL.Scheme != "https" &&
		!isLoopbackHostname(parsedAPIURL.Hostname()) {
		return nil, errors.New("LIVEKIT_API_URL must use https or loopback in production")
	}
	return &LiveKitFallback{
		URL:       Origin(parsedURL),
		APIURL:    Origin(parsedAPIURL),
		APIKey:    apiKey,
		APISecret: apiSecret,
	}, nil
}

// isLoopbackHostname ports isLoopbackHostname. url.URL.Hostname strips the IPv6
// brackets, so only the unbracketed "::1" can actually match here.
func isLoopbackHostname(hostname string) bool {
	return hostname == "localhost" || hostname == "127.0.0.1" ||
		hostname == "[::1]" || hostname == "::1"
}

// parseURLList ports parseUrlList.
func parseURLList(value string, name string) ([]string, error) {
	if strings.TrimFunc(value, protocol.IsJSWhitespace) == "" {
		return nil, nil
	}
	entries := strings.Split(value, ",")
	list := make([]string, 0, len(entries))
	for _, entry := range entries {
		trimmed := strings.TrimFunc(entry, protocol.IsJSWhitespace)
		if trimmed == "" {
			return nil, fmt.Errorf("%s contains an empty URL", name)
		}
		list = append(list, trimmed)
	}
	return list, nil
}

// parseStunURLList ports parseStunUrlList. The TypeScript `maximum` parameter
// was only ever the default.
func parseStunURLList(value string, name string) ([]string, error) {
	values, err := parseURLList(value, name)
	if err != nil {
		return nil, err
	}
	if len(values) > protocol.MaxIceServerURLs {
		return nil, fmt.Errorf("%s must contain at most %d URLs", name, protocol.MaxIceServerURLs)
	}
	for _, value := range values {
		if !protocol.ValidStunURLValue(value) {
			return nil, fmt.Errorf("%s contains an invalid STUN URL", name)
		}
	}
	return values, nil
}

// parseOrigins ports parseOrigins.
func parseOrigins(value string, fallback string) (map[string]struct{}, error) {
	origins, err := parseURLList(value, "ALLOWED_ORIGINS")
	if err != nil {
		return nil, err
	}
	if len(origins) == 0 {
		origins = []string{fallback}
	}
	set := make(map[string]struct{}, len(origins))
	for _, entry := range origins {
		origin, err := toOrigin(entry)
		if err != nil {
			return nil, err
		}
		set[origin] = struct{}{}
	}
	return set, nil
}

// toOrigin ports toOrigin. The TypeScript let an unparsable entry escape as a
// raw TypeError from `new URL`; it fails startup here with a message instead.
func toOrigin(value string) (string, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("Allowed origins must be valid http or https URLs")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", errors.New("Allowed origins must use http or https")
	}
	return Origin(parsed), nil
}

// parseOriginURL ports the `new URL` + protocol + shape ladder that
// PUBLIC_BASE_URL, LIVEKIT_URL and LIVEKIT_API_URL each repeat, and returns the
// WHATWG-normalised URL (lowercase host, default port removed, path "/").
func parseOriginURL(value, name, scheme, alternative string) (*url.URL, error) {
	parsed, err := url.Parse(value)
	// net/url accepts relative references and opaque URLs that the WHATWG
	// parser rejects (or, for "wss:host", repairs); require both parts.
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("%s must be a valid %s or %s origin", name, scheme, alternative)
	}
	if parsed.Scheme != scheme && parsed.Scheme != alternative {
		return nil, fmt.Errorf("%s must use %s or %s", name, scheme, alternative)
	}
	// TS: url.username || url.password || url.pathname !== "/" || url.search ||
	// url.hash. WHATWG reports "/" for an empty path, which net/url leaves "".
	if hasUserinfo(parsed) || (parsed.Path != "" && parsed.Path != "/") ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf(
			"%s must be an origin without credentials, path, query, or fragment", name)
	}
	return &url.URL{Scheme: parsed.Scheme, Host: normalizedHost(parsed), Path: "/"}, nil
}

// hasUserinfo ports `url.username || url.password`: WHATWG reports empty
// strings for "https://@host" and "https://:@host", where net/url reports a
// non-nil (but empty) Userinfo.
func hasUserinfo(parsed *url.URL) bool {
	if parsed.User == nil {
		return false
	}
	password, _ := parsed.User.Password()
	return parsed.User.Username() != "" || password != ""
}

// Origin ports the WHATWG URL `origin` getter for the http/https/ws/wss schemes
// this package accepts: new URL("https://Example.com:443/").origin is
// "https://example.com". It is exported so app and cmd can compare request
// origins without a second copy of the rule.
func Origin(parsed *url.URL) string {
	return parsed.Scheme + "://" + normalizedHost(parsed)
}

// normalizedHost lowercases the host, keeps an IPv6 literal bracketed and drops
// a port equal to the scheme default. Non-ASCII hosts are not IDNA-encoded, so
// they keep the form they were configured with.
func normalizedHost(parsed *url.URL) string {
	host := strings.ToLower(parsed.Hostname())
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	// WHATWG parses the port as a number, so "0443" and "443" are both default.
	if number, err := strconv.Atoi(parsed.Port()); err == nil {
		if port := strconv.Itoa(number); port != defaultSchemePort(parsed.Scheme) {
			host += ":" + port
		}
	}
	return host
}

func defaultSchemePort(scheme string) string {
	switch scheme {
	case "http", "ws":
		return "80"
	case "https", "wss":
		return "443"
	}
	return ""
}

// decimalNumberPattern is the StrDecimalLiteral grammar Number(string) accepts.
var decimalNumberPattern = regexp.MustCompile(
	`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

// jsNumber ports Number(string). The second result is false where JavaScript
// yields NaN; values JavaScript renders as Infinity are reported as NaN too,
// because every caller rejects them through Number.isSafeInteger anyway.
func jsNumber(value string) (float64, bool) {
	text := strings.TrimFunc(value, protocol.IsJSWhitespace)
	if text == "" {
		return 0, true // Number("") and Number(" ") are 0.
	}
	if len(text) > 2 && text[0] == '0' {
		if base := numericBase(text[1]); base != 0 {
			number, err := strconv.ParseUint(text[2:], base, 64)
			return float64(number), err == nil
		}
	}
	if !decimalNumberPattern.MatchString(text) {
		return 0, false
	}
	number, err := strconv.ParseFloat(text, 64)
	return number, err == nil
}

func numericBase(marker byte) int {
	switch marker {
	case 'x', 'X':
		return 16
	case 'o', 'O':
		return 8
	case 'b', 'B':
		return 2
	}
	return 0
}
