package app

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/server/config"
	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

const (
	defaultSessionTTLSeconds = 24 * 60 * 60
	cookieVersion            = "v1"
)

var (
	accessExpiresPattern   = regexp.MustCompile(`^[0-9]+$`)
	accessSignaturePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
)

// siteAccessOptions configures cookie lifetime, signing and transport policy.
type siteAccessOptions struct {
	// Password empty means site access is not required.
	Password string
	// Secure selects the __Host- cookie name and appends the Secure attribute.
	Secure bool
	// Now returns Unix milliseconds; nil uses the wall clock.
	Now func() int64
	// TTLSeconds of 0 selects the default 24-hour lifetime.
	TTLSeconds int
}

// siteAccessGate issues and verifies the stateless site-access cookie.
type siteAccessGate struct {
	password   string
	secure     bool
	now        func() int64
	ttlSeconds int
}

// One Local authority can be served through HTTPS public links and HTTP LAN
// origins. Select the cookie contract by its configured destination, never by
// the initiating Origin or an untrusted forwarded-protocol header.
func (s *Server) siteAccessForRequest(request *http.Request) *siteAccessGate {
	if !s.siteAccess.secure || request.TLS != nil {
		return s.siteAccess
	}
	plain := config.Origin(&url.URL{Scheme: "http", Host: request.Host})
	secure := config.Origin(&url.URL{Scheme: "https", Host: request.Host})
	_, allowsPlain := s.config.AllowedOrigins[plain]
	_, allowsSecure := s.config.AllowedOrigins[secure]
	if !allowsPlain || allowsSecure || strings.EqualFold(request.Host, s.config.PublicBaseURL.Host) {
		return s.siteAccess
	}
	access := *s.siteAccess
	access.secure = false
	return &access
}

// newSiteAccess mirrors the SiteAccess constructor, including its TTL check.
func newSiteAccess(options siteAccessOptions) (*siteAccessGate, error) {
	ttlSeconds := options.TTLSeconds
	if ttlSeconds == 0 {
		ttlSeconds = defaultSessionTTLSeconds
	}
	if ttlSeconds < 0 || int64(ttlSeconds) > protocol.MaxSafeInteger {
		return nil, errors.New("Access session TTL must be a positive integer")
	}
	now := options.Now
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	return &siteAccessGate{
		password:   options.Password,
		secure:     options.Secure,
		now:        now,
		ttlSeconds: ttlSeconds,
	}, nil
}

// required reports whether a password is configured.
func (a *siteAccessGate) required() bool {
	return a.password != ""
}

// passwordMatches mirrors passwordMatches: an unset password accepts anything,
// a set password needs a non-empty exact match.
func (a *siteAccessGate) passwordMatches(value string) bool {
	return !a.required() || (value != "" && secretMatches(value, a.password))
}

// isAuthenticated mirrors isAuthenticated over a raw Cookie request header.
func (a *siteAccessGate) isAuthenticated(cookieHeader string) bool {
	if !a.required() {
		return true
	}
	value := readCookie(cookieHeader, a.cookieName())
	if value == "" {
		return false
	}
	segments := strings.Split(value, ".")
	if len(segments) != 3 ||
		segments[0] != cookieVersion ||
		!accessExpiresPattern.MatchString(segments[1]) ||
		!accessSignaturePattern.MatchString(segments[2]) {
		return false
	}
	// Expiry is already decimal; parsing still enforces integer bounds.
	expiresAt, err := strconv.ParseInt(segments[1], 10, 64)
	if err != nil || expiresAt > protocol.MaxSafeInteger {
		return false
	}
	if expiresAt <= floorSeconds(a.now()) {
		return false
	}
	// Sign the received text, not a re-rendered payload.
	return secretMatches(segments[2], a.sign(segments[0]+"."+segments[1]))
}

// createCookie mirrors createCookie and returns the Set-Cookie header value,
// or "" where TS returned undefined (site access is not required).
func (a *siteAccessGate) createCookie() string {
	if !a.required() {
		return ""
	}
	expiresAt := floorSeconds(a.now()) + int64(a.ttlSeconds)
	payload := cookieVersion + "." + strconv.FormatInt(expiresAt, 10)
	value := payload + "." + a.sign(payload)
	// Attribute order is the TS array order; the app writes it verbatim.
	attributes := []string{
		a.cookieName() + "=" + value,
		"Path=/",
		"Max-Age=" + strconv.Itoa(a.ttlSeconds),
		"HttpOnly",
		"SameSite=Strict",
	}
	if a.secure {
		attributes = append(attributes, "Secure")
	}
	return strings.Join(attributes, "; ")
}

func (a *siteAccessGate) cookieName() string {
	if a.secure {
		return "__Host-piik-site-access"
	}
	return "piik-site-access"
}

func (a *siteAccessGate) sign(payload string) string {
	mac := hmac.New(sha256.New, []byte(a.password))
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// floorSeconds is Math.floor(milliseconds / 1000); Go's integer division
// truncates toward zero, so negative clocks need the adjustment.
func floorSeconds(milliseconds int64) int64 {
	seconds := milliseconds / 1_000
	if milliseconds < 0 && milliseconds%1_000 != 0 {
		seconds--
	}
	return seconds
}

// readCookie mirrors the TS reader: the first part whose trimmed name matches
// wins, and an empty value counts as absent.
func readCookie(header string, name string) string {
	for _, part := range strings.Split(header, ";") {
		separator := strings.IndexByte(part, '=')
		if separator != -1 && strings.TrimSpace(part[:separator]) == name {
			return strings.TrimSpace(part[separator+1:])
		}
	}
	return ""
}

// secretMatches compares through SHA-256 digests so the comparison is constant
// time regardless of length, exactly as the TS helper does.
func secretMatches(actual string, expected string) bool {
	actualDigest := sha256.Sum256([]byte(actual))
	expectedDigest := sha256.Sum256([]byte(expected))
	return subtle.ConstantTimeCompare(actualDigest[:], expectedDigest[:]) == 1
}
