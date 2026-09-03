package directpair

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/pion/stun/v3"
	"github.com/pion/webrtc/v4"
)

const (
	protocolVersion     = 1
	maxCodeBytes        = 96 * 1024
	maxSDPBytes         = 64 * 1024
	maxSTUNURLs         = 4
	maxSTUNURLBytes     = 512
	DefaultSTUNURL      = "stun:stun.cloudflare.com:3478"
	controlChannelLabel = "screener-pair-control-v1"
	streamChannelLabel  = "screener-pair-stream-v1"
)

var invitationPattern = regexp.MustCompile(
	`^/r/[1-9][0-9]{3}#v=[A-Za-z0-9_-]{21}[AQgw]$`,
)

type pairingCode struct {
	Version  int      `json:"version"`
	Kind     string   `json:"kind"`
	SDP      string   `json:"sdp"`
	Port     int      `json:"port,omitempty"`
	STUNURLs []string `json:"stunUrls,omitempty"`
}

func encodeDescription(
	kind string,
	description webrtc.SessionDescription,
	stunURLs []string,
	port int,
) (string, error) {
	if description.SDP == "" || len(description.SDP) > maxSDPBytes {
		return "", errors.New("pairing description is invalid")
	}
	payload, err := json.Marshal(pairingCode{
		Version:  protocolVersion,
		Kind:     kind,
		SDP:      description.SDP,
		Port:     port,
		STUNURLs: stunURLs,
	})
	if err != nil {
		return "", err
	}
	if len(payload) > maxCodeBytes {
		return "", errors.New("pairing description is too large")
	}
	return base64.RawURLEncoding.EncodeToString(payload), nil
}

func decodeDescription(
	raw string,
	expectedKind string,
) (webrtc.SessionDescription, []string, int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > base64.RawURLEncoding.EncodedLen(maxCodeBytes) {
		return webrtc.SessionDescription{}, nil, 0, errors.New("pairing code is invalid")
	}
	payload, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(payload) > maxCodeBytes {
		return webrtc.SessionDescription{}, nil, 0, errors.New("pairing code is invalid")
	}
	var code pairingCode
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&code) != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		code.Version != protocolVersion || code.Kind != expectedKind ||
		code.SDP == "" || len(code.SDP) > maxSDPBytes {
		return webrtc.SessionDescription{}, nil, 0, errors.New("pairing code is invalid")
	}
	if (expectedKind == "offer" && (code.Port < 1 || code.Port > 65_535)) ||
		(expectedKind == "answer" && (code.Port != 0 || len(code.STUNURLs) != 0)) {
		return webrtc.SessionDescription{}, nil, 0, errors.New("pairing code is invalid")
	}
	stunURLs, err := validateSTUNURLs(code.STUNURLs)
	if err != nil {
		return webrtc.SessionDescription{}, nil, 0, errors.New("pairing code is invalid")
	}
	descriptionType := webrtc.SDPTypeOffer
	if expectedKind == "answer" {
		descriptionType = webrtc.SDPTypeAnswer
	}
	return webrtc.SessionDescription{
		Type: descriptionType,
		SDP:  code.SDP,
	}, stunURLs, code.Port, nil
}

func validateSTUNURLs(values []string) ([]string, error) {
	if len(values) > maxSTUNURLs {
		return nil, errors.New("too many STUN URLs")
	}
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		parsed, err := stun.ParseURI(value)
		if err != nil || len(value) > maxSTUNURLBytes ||
			parsed.Scheme != stun.SchemeTypeSTUN || parsed.Proto != stun.ProtoTypeUDP {
			return nil, errors.New("STUN URL is invalid")
		}
		if _, exists := seen[value]; exists {
			return nil, errors.New("STUN URL is duplicated")
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result, nil
}

func ValidateSTUNURL(value string) error {
	_, err := validateSTUNURLs([]string{value})
	return err
}

func invitationPath(raw string) (string, int, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "http" ||
		parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" {
		return "", 0, errors.New("a complete Local Viewer invitation is required")
	}
	path := parsed.EscapedPath() + "#" + parsed.Fragment
	if !invitationPattern.MatchString(path) {
		return "", 0, errors.New("a complete Local Viewer invitation is required")
	}
	port := 80
	if parsed.Port() != "" {
		port, err = strconv.Atoi(parsed.Port())
		if err != nil || port < 1 || port > 65_535 {
			return "", 0, errors.New("a complete Local Viewer invitation is required")
		}
	}
	return path, port, nil
}
