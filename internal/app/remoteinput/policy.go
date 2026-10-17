package remoteinput

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"time"
)

// ValidatePolicy also runs before a capture-owned OS permission dialog.
func ValidatePolicy(mode, password string) error {
	if mode != "off" && mode != "ask" && mode != "room" && mode != "password" ||
		len(password) > 512 || (mode == "password") != (password != "") {
		return errors.New("invalid remote input policy")
	}
	return nil
}

// SetPolicy is reachable only through the owning Host's native-control session.
// It lives with the current source, never in App config, room access or storage.
func (s *Session) SetPolicy(mode, password string) error {
	if s == nil {
		return errors.New("remote input is unavailable")
	}
	if err := ValidatePolicy(mode, password); err != nil {
		return err
	}
	m := s.manager
	m.mu.Lock()
	s.policyRevision++
	revision := s.policyRevision
	available := !m.closed && !s.closed && (mode == "off" || s.available())
	m.mu.Unlock()
	if !available {
		return errors.New("remote input is unavailable")
	}
	// OS input permission is requested only by the Host enabling control, never
	// by App startup, capture discovery or a remote Viewer's request. The dialog
	// must not hold the grant lock; recheck the source after it returns.
	if mode != "off" {
		if err := m.sink.Authorize(); err != nil {
			return err
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || s.closed || s.policyRevision != revision || (mode != "off" && !s.available()) {
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
	s.policyRevision++
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
