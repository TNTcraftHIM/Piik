package remoteinput

import "errors"

var errGamepadUnavailable = errors.New("virtual gamepad output unavailable")

type gamepadReport struct {
	Buttons      uint16 `json:"buttons"`
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

// Caller holds manager.mu. A device belongs to one current grant, never to a
// Viewer-supplied slot or an OS player index.
func (m *Manager) assignGamepad(c *connection) error {
	if !c.extended || !c.owner.coPlay || m.gamepads == nil {
		return errGamepadUnavailable
	}
	count := 0
	for _, other := range m.connections {
		if other.pad != nil {
			count++
		}
	}
	if count >= 4 {
		return errors.New("all four remote gamepad slots are occupied")
	}
	pad, err := m.gamepads.Open()
	if err != nil {
		return err
	}
	c.pad = pad
	return nil
}

func (m *Manager) failGamepad(c *connection) {
	m.releaseConnection(c)
	m.reply(c, "failed", "gamepad")
	c.owner.notify()
}

func (m *Manager) receiveGamepad(c *connection, event inputEvent) {
	if c.pad == nil {
		return
	}
	if event.Type == "reset" {
		if err := c.pad.Update(gamepadReport{}); err != nil {
			m.failGamepad(c)
		}
		return
	}
	if event.Type != "gamepad" || event.Gamepad == nil || event.Gamepad.Buttons & ^uint16(0xf3ff) != 0 {
		return
	}
	if _, focused := m.refreshActive(); !focused {
		return
	}
	if err := c.pad.Update(*event.Gamepad); err != nil {
		m.failGamepad(c)
	}
}
