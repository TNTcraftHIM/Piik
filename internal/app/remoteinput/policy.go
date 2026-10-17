package remoteinput

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"time"
)

func validatePolicy(mode, password string) error {
	if mode != "off" && mode != "ask" && mode != "room" && mode != "password" ||
		len(password) > 512 || (mode == "password") != (password != "") {
		return errors.New("invalid remote input policy")
	}
	return nil
}

// PolicyChange owns one Host intent from dispatch through OS/capture preparation.
// It never owns the lifetime of an installed capture stream.
type PolicyChange struct {
	session  *Session
	ctx      context.Context
	cancel   context.CancelFunc
	mode     string
	password [32]byte
}

func (s *Session) BeginPolicy(ctx context.Context, mode, password string) (*PolicyChange, error) {
	if s == nil {
		return nil, errors.New("remote input is unavailable")
	}
	if err := validatePolicy(mode, password); err != nil {
		return nil, err
	}
	m := s.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || s.closed || ctx.Err() != nil || (mode != "off" && !s.available()) {
		return nil, errors.New("remote input is unavailable")
	}
	s.cancelPolicy()
	ctx, cancel := context.WithCancel(ctx)
	change := &PolicyChange{session: s, ctx: ctx, cancel: cancel, mode: mode}
	if mode == "password" {
		change.password = sha256.Sum256([]byte(password))
	}
	s.policyChange = change
	return change, nil
}

func (change *PolicyChange) Context() context.Context { return change.ctx }

func (change *PolicyChange) Close() {
	s := change.session
	s.manager.mu.Lock()
	defer s.manager.mu.Unlock()
	if s.policyChange == change {
		s.cancelPolicy()
	}
}

func (change *PolicyChange) Apply() error {
	s := change.session
	m := s.manager
	if err := change.ctx.Err(); err != nil {
		return err
	}
	// OS input permission is requested only by the Host enabling control, never
	// by App startup, capture discovery or a remote Viewer's request. The dialog
	// must not hold the grant lock; recheck the source after it returns.
	if change.mode != "off" {
		if err := m.sink.Authorize(); err != nil {
			return err
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || s.closed || s.policyChange != change || change.ctx.Err() != nil || (change.mode != "off" && !s.available()) {
		return errors.New("remote input is unavailable")
	}
	s.setPolicy(change.mode, change.password)
	return nil
}

// Caller holds manager.mu. Cancellation invalidates preparation before it can
// commit a newer permission, even if an OS dialog itself cannot be dismissed.
func (s *Session) cancelPolicy() {
	if s.policyChange != nil {
		s.policyChange.cancel()
		s.policyChange = nil
	}
}

// Caller holds manager.mu. A policy change retires all previous requests and
// grants, so an old approval cannot acquire the newly configured permission.
func (s *Session) setPolicy(mode string, password [32]byte) {
	s.cancelPolicy()
	s.applyPolicy(mode, password)
}

func (s *Session) applyPolicy(mode string, password [32]byte) {
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
