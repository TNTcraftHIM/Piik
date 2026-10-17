package remoteinput

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"time"
)

// SetPolicy is reachable only through the owning Host's native-control session.
// It lives with the current source, never in App config, room access or storage.
func (s *Session) SetPolicy(mode, password string) error {
	if s == nil {
		return errors.New("remote input is unavailable")
	}
	if mode != "off" && mode != "ask" && mode != "room" && mode != "password" ||
		len(password) > 512 || (mode == "password") != (password != "") {
		return errors.New("invalid remote input policy")
	}
	m := s.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || s.closed || (mode != "off" && !s.available()) {
		return errors.New("remote input is unavailable")
	}
	var digest [32]byte
	if mode == "password" {
		digest = sha256.Sum256([]byte(password))
	}
	s.setPolicy(mode, digest)
	return nil
}

// Caller holds manager.mu. A policy change retires all previous requests and
// grants, so an old approval cannot acquire the newly configured permission.
func (s *Session) setPolicy(mode string, password [32]byte) {
	s.mode, s.password = mode, password
	for _, c := range s.manager.connections {
		if c.owner == s {
			s.manager.revoke(c)
		}
	}
	s.notify()
}

func (s *Session) authorize(password string) string {
	if s.mode != "password" {
		return ""
	}
	// One password attempt per second for this source, shared across endpoints
	// and route changes. The short-lived verifier is never logged or persisted.
	now := time.Now()
	if now.Before(s.passwordRetry) {
		return "retry"
	}
	s.passwordRetry = now.Add(time.Second)
	digest := sha256.Sum256([]byte(password))
	if len(password) > 512 || subtle.ConstantTimeCompare(digest[:], s.password[:]) != 1 {
		return "password"
	}
	return ""
}
