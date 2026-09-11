package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

// localPasswordPattern admits 8..128 one-byte visible ASCII characters.
var localPasswordPattern = regexp.MustCompile(`^[\x21-\x7e]{8,128}$`)

// LocalOptions describes App-selected Local composition. It never reads the
// process environment.
type LocalOptions struct {
	// Port 0 selects the default 8787.
	Port                  int
	PublicAddress         string
	PublicOrigin          string
	AllowedAddresses      []string
	SiteAccessPassword    string
	STUNURLs              []string
	NATPredictionSTUNURLs []string
}

// Local ports createLocalServerConfig.
func Local(options LocalOptions) (Config, error) {
	port := options.Port
	if port == 0 {
		port = defaultPort
	}
	if port < 1 || port > maxPort {
		return Config{}, fmt.Errorf("Local server port must be an integer between 1 and %d", maxPort)
	}
	publicAddress, err := localIPv4(options.PublicAddress, "public address")
	if err != nil {
		return Config{}, err
	}
	if publicAddress == "0.0.0.0" || strings.HasPrefix(publicAddress, "127.") {
		return Config{}, errors.New("Local server public address must be reachable from the LAN")
	}
	siteAccessPassword := strings.TrimFunc(options.SiteAccessPassword, protocol.IsJSWhitespace)
	if siteAccessPassword != "" && !localPasswordPattern.MatchString(siteAccessPassword) {
		return Config{}, errors.New("Local access password must contain 8 to 128 visible ASCII bytes")
	}

	allowedAddresses := []string{publicAddress}
	for _, address := range options.AllowedAddresses {
		normalized, err := localIPv4(address, "allowed address")
		if err != nil {
			return Config{}, err
		}
		if !slices.Contains(allowedAddresses, normalized) {
			allowedAddresses = append(allowedAddresses, normalized)
		}
	}

	// Copy non-nil lists so configured-empty prediction does not derive auxiliary URLs.
	stunURLs := append([]string{}, options.STUNURLs...)
	natPredictionSTUNURLs := append([]string{}, options.NATPredictionSTUNURLs...)
	if len(stunURLs)+len(natPredictionSTUNURLs) > protocol.MaxIceServerURLs ||
		!allValidStunURLs(stunURLs) ||
		!allValidStunURLs(natPredictionSTUNURLs) ||
		(len(natPredictionSTUNURLs) != 0 &&
			len(natPredictionSTUNURLs) != protocol.MaxNatPredictionAuxiliaryStunURLs) ||
		(len(natPredictionSTUNURLs) > 0 && len(stunURLs) == 0) {
		return Config{}, errors.New("Local STUN URLs are invalid")
	}

	// Local is loopback/LAN HTTP; its origin always spells out the port.
	origin := func(host string) string { return fmt.Sprintf("http://%s:%d", host, port) }
	publicBaseURL := &url.URL{Scheme: "http", Host: fmt.Sprintf("%s:%d", publicAddress, port), Path: "/"}
	if options.PublicOrigin != "" {
		publicBaseURL, err = publicHTTPSOrigin(options.PublicOrigin)
		if err != nil {
			return Config{}, err
		}
	}

	allowedOrigins := map[string]struct{}{
		origin("localhost"): {},
		origin("127.0.0.1"): {},
	}
	for _, address := range allowedAddresses {
		allowedOrigins[origin(address)] = struct{}{}
	}
	allowedOrigins[Origin(publicBaseURL)] = struct{}{}

	return Config{
		Env:                       EnvironmentProduction,
		Port:                      port,
		ListenHost:                "0.0.0.0",
		PublicBaseURL:             publicBaseURL,
		AllowedOrigins:            allowedOrigins,
		SiteAccessPassword:        siteAccessPassword,
		MaxViewersPerRoom:         protocol.MaxViewersPerRoomLimit,
		EndpointMediaCopyCapacity: protocol.DefaultEndpointMediaCopyCapacity,
		STUNURLs:                  stunURLs,
		NATPredictionEnabled:      len(natPredictionSTUNURLs) == protocol.MaxNatPredictionAuxiliaryStunURLs,
		NATPredictionSTUNURLs:     natPredictionSTUNURLs,
	}, nil
}

func allValidStunURLs(values []string) bool {
	for _, value := range values {
		if !protocol.ValidStunURLValue(value) {
			return false
		}
	}
	return true
}

// publicHTTPSOrigin ports publicHTTPSOrigin: every failure shares one message.
func publicHTTPSOrigin(value string) (*url.URL, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" ||
		hasUserinfo(parsed) || (parsed.Path != "" && parsed.Path != "/") ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("Local public origin must be an HTTPS origin")
	}
	return &url.URL{Scheme: "https", Host: normalizedHost(parsed), Path: "/"}, nil
}

// localIPv4 ports localIPv4. Node's isIP(value) === 4 accepts only a dotted
// quad, so an IPv4-mapped IPv6 literal such as "::ffff:192.168.1.10" — which
// net.ParseIP(...).To4() does resolve — is rejected here as well.
func localIPv4(value string, name string) (string, error) {
	address := strings.TrimFunc(value, protocol.IsJSWhitespace)
	parsed := net.ParseIP(address)
	if parsed == nil || parsed.To4() == nil || strings.ContainsRune(address, ':') {
		return "", fmt.Errorf("Local server %s must be an IPv4 address", name)
	}
	return address, nil
}
