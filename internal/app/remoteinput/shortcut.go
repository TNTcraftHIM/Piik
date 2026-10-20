package remoteinput

import "errors"

const defaultStopKey = 10

// F12 is reserved by Windows debuggers even when no debugger is running.
func ValidStopKey(key int) bool { return key >= 1 && key <= 11 }

type StopShortcut struct {
	Key       int  `json:"key"`
	Available bool `json:"available"`
}

func (m *Manager) SupportsStopShortcut() bool { return m != nil && m.registerStop != nil }

// Called with the grant lock held. Registration begins with an explicit Host
// action, so another application's hotkey cannot disable App startup or capture.
func (m *Manager) ensureStopShortcut() error {
	if m.registerStop == nil || m.stopShortcut != nil {
		return nil
	}
	stop, err := m.registerStop(m.stopKey)
	if err == nil {
		m.stopShortcut = stop
	}
	return err
}

// Caller holds mu. A configured chord belongs to enabled input sessions, not
// the App process: idle sharing must leave it available to other applications.
func (m *Manager) releaseIdleShortcut() {
	if m.stopShortcut == nil {
		return
	}
	for session := range m.sessions {
		if session.mode != "off" {
			return
		}
	}
	m.stopShortcut()
	m.stopShortcut = nil
}

func (m *Manager) ReadStopShortcut() (StopShortcut, error) {
	if !m.SupportsStopShortcut() {
		return StopShortcut{}, errors.New("remote-control shortcut is unavailable")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return StopShortcut{}, errors.New("remote input is closed")
	}
	state := StopShortcut{Key: m.stopKey, Available: m.stopShortcut != nil}
	if !state.Available {
		stop, err := m.registerStop(m.stopKey)
		state.Available = err == nil
		if stop != nil {
			stop()
		}
	}
	return state, nil
}

func (m *Manager) SetStopShortcut(key int) (StopShortcut, error) {
	if !m.SupportsStopShortcut() || !ValidStopKey(key) {
		return StopShortcut{}, errors.New("remote-control shortcut is invalid or unavailable")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return StopShortcut{}, errors.New("remote input is closed")
	}
	if key == m.stopKey && m.stopShortcut != nil {
		return StopShortcut{key, true}, nil
	}
	stop, err := m.registerStop(key)
	if err != nil {
		return StopShortcut{}, err
	}
	// Keep the old working chord until registration succeeds.
	if m.stopShortcut != nil {
		m.stopShortcut()
	}
	if m.stopShortcut == nil {
		stop()
	} else {
		m.stopShortcut = stop
	}
	m.stopKey = key
	for session := range m.sessions {
		session.notify()
	}
	return StopShortcut{key, true}, nil
}
