package remoteinput

import "errors"

var errGamepadUnavailable = errors.New("virtual gamepad output unavailable")

// Button bits follow W3C standard indices. Sticks use signed 16-bit values,
// with Y increasing downward; triggers use 0..255. Native formats stay local.
type gamepadReport struct {
	Buttons      uint32 `json:"buttons"`
	LeftTrigger  uint8  `json:"leftTrigger"`
	RightTrigger uint8  `json:"rightTrigger"`
	LeftX        int16  `json:"leftX"`
	LeftY        int16  `json:"leftY"`
	RightX       int16  `json:"rightX"`
	RightY       int16  `json:"rightY"`
}

type gamepadDevice interface {
	Update(gamepadReport) error
	Close() error
}

type gamepadBackend interface {
	Open() (gamepadDevice, error)
	Close() error
}

// One creation may enumerate an OS device at a time. It must never hold the
// input lock or replay a report from before enumeration completed.
func (m *Manager) assignGamepad(c *connection) {
	if m.gamepadOpening {
		return
	}
	if m.gamepads == nil {
		m.failGamepad(c)
		return
	}
	backend, grant := m.gamepads, c.grant
	m.gamepadOpening = true
	go func() {
		pad, err := backend.Open()
		m.mu.Lock()
		valid := !m.closed && !c.owner.closed && c.owner.available() && c.owner.coPlay &&
			c.grant == grant && c.grant != "" && m.connections[endpointKey{c.owner, c.id}] == c
		if valid {
			if err != nil {
				m.failGamepad(c)
			} else {
				c.pad = pad
				c.owner.notify()
			}
		}
		m.mu.Unlock()
		if !valid && pad != nil {
			_ = pad.Close()
		}
		m.mu.Lock()
		m.gamepadOpening = false
		m.mu.Unlock()
	}()
}

func (m *Manager) failGamepad(c *connection) {
	if c.pad != nil {
		_ = c.pad.Close()
		c.pad = nil
	}
	c.padFailed = true
	m.reply(c, m.state(c), "gamepad")
	c.owner.notify()
}

func (m *Manager) receiveGamepad(c *connection, event inputEvent) {
	if !c.extended || !c.owner.coPlay || c.padFailed {
		return
	}
	if event.Type == "gamepad-reset" {
		if c.pad != nil {
			if err := c.pad.Update(gamepadReport{}); err != nil {
				m.failGamepad(c)
			}
		}
		return
	}
	if event.Type != "gamepad" || event.Gamepad == nil || event.Gamepad.Buttons & ^uint32((1<<17)-1) != 0 {
		return
	}
	if _, focused := m.refreshActive(); !focused {
		return
	}
	if c.pad == nil {
		m.assignGamepad(c)
		return
	}
	if err := c.pad.Update(*event.Gamepad); err != nil {
		m.failGamepad(c)
	}
}
