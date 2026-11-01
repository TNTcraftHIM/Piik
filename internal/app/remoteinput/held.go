package remoteinput

import (
	"errors"
	"fmt"
)

type controllerTextSink struct {
	manager    *Manager
	controller *connection
}

func (s controllerTextSink) Reset() error { return s.manager.resetHeld(s.controller.owner) }
func (s controllerTextSink) Apply(b bounds, event inputEvent) error {
	return s.manager.applyHeld(s.controller, b, event)
}

// Whole-source cleanup may use the platform's tracked physical state. Keep the
// logical release debt until Reset actually succeeds, including after retirement.
func (m *Manager) resetHeld(s *Session) error {
	if m.pendingKeys == nil {
		m.pendingKeys = make(map[string]bool)
	}
	if m.pendingButtons == nil {
		m.pendingButtons = make(map[int]bool)
	}
	for _, c := range m.connections {
		if c.owner != s {
			continue
		}
		for key := range c.keys {
			m.pendingKeys[key] = true
		}
		for button := range c.buttons {
			m.pendingButtons[button] = true
		}
		c.keys, c.buttons = nil, nil
	}
	err := m.sink.Reset()
	if err == nil {
		clear(m.pendingKeys)
		clear(m.pendingButtons)
	}
	return err
}

// Failed releases outlive their departing controller. Only releases are retried;
// pointer movement, presses and committed text are never replayed.
func (m *Manager) releaseKey(code string) error {
	err := m.applyInput(bounds{}, inputEvent{Type: "key", Code: code})
	if err != nil {
		if m.pendingKeys == nil {
			m.pendingKeys = make(map[string]bool)
		}
		m.pendingKeys[code] = true
	} else {
		delete(m.pendingKeys, code)
	}
	return err
}

func (m *Manager) releaseButton(button int) error {
	err := m.applyInput(bounds{}, inputEvent{Type: "button", Button: button})
	if err != nil {
		if m.pendingButtons == nil {
			m.pendingButtons = make(map[int]bool)
		}
		m.pendingButtons[button] = true
	} else {
		delete(m.pendingButtons, button)
	}
	return err
}

func (m *Manager) retryReleases() error {
	var result error
	for code := range m.pendingKeys {
		if err := m.releaseKey(code); err != nil {
			result = errors.Join(result, fmt.Errorf("key release retry: %w", err))
		}
	}
	for button := range m.pendingButtons {
		if err := m.releaseButton(button); err != nil {
			result = errors.Join(result, fmt.Errorf("button release retry: %w", err))
		}
	}
	return result
}

func (m *Manager) noteInputResult(c *connection, err error) {
	failed := err != nil
	if c.inputFailed != failed {
		c.inputFailed = failed
		m.send(c, m.state(c))
	}
}

func (m *Manager) applyHeld(c *connection, b bounds, event inputEvent) error {
	releaseErr := m.retryReleases()
	releasing := (event.Type == "key" || event.Type == "button") && !event.Down
	if !releasing && (len(m.pendingKeys) != 0 || len(m.pendingButtons) != 0) {
		return fmt.Errorf("held input cleanup is unavailable (%d key, %d button releases pending): %w", len(m.pendingKeys), len(m.pendingButtons), releaseErr)
	}
	switch event.Type {
	case "key":
		if event.Code == "" || len(event.Code) > 32 || event.Down && len(c.keys) >= 256 && !c.keys[event.Code] {
			return nil
		}
		if event.Down {
			// A repeat from this holder is input; another holder shares the press.
			if c.keys[event.Code] || !m.keyHeld(event.Code) {
				if err := m.applyInput(b, event); err != nil {
					return err
				}
			}
			if c.keys == nil {
				c.keys = make(map[string]bool)
			}
			c.keys[event.Code] = true
		} else {
			if !c.keys[event.Code] {
				return nil
			}
			delete(c.keys, event.Code)
			if !m.keyHeld(event.Code) {
				return m.releaseKey(event.Code)
			}
		}
	case "button":
		if event.Button < 0 || event.Button > 4 || c.buttons[event.Button] == event.Down {
			return nil
		}
		if event.Down {
			if !m.buttonHeld(event.Button) {
				if err := m.applyInput(b, event); err != nil {
					return err
				}
			}
			if c.buttons == nil {
				c.buttons = make(map[int]bool)
			}
			c.buttons[event.Button] = true
		} else {
			delete(c.buttons, event.Button)
			if !m.buttonHeld(event.Button) {
				return m.releaseButton(event.Button)
			}
		}
	default:
		return m.applyInput(b, event)
	}
	return nil
}
