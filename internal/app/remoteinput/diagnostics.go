package remoteinput

// Incoming events and sink Apply calls are separate counts: held-input
// deduplication can avoid a call, while text and release cleanup can make several.
// API acceptance is Apply's return value, never proof of OS delivery. Reset
// calls are not expanded into inferred per-key/button API operations.
type DiagnosticFamilyCounters struct {
	Parsed      uint64 `json:"parsed"`
	Authorized  uint64 `json:"authorized"`
	TargetReady uint64 `json:"targetReady"`
	APIAttempts uint64 `json:"apiAttempts"`
	APIAccepted uint64 `json:"apiAccepted"`
	APIRejected uint64 `json:"apiRejected"`
}

// ReceivedPackets counts current, known-endpoint payloads, not raw channel traffic.
// Packet type is unknown before decryption and parsing. Those totals include
// control/gamepad messages; family counters cover keyboard and mouse actions.
type DiagnosticCounters struct {
	ReceivedPackets  uint64                   `json:"receivedPackets"`
	DecryptedPackets uint64                   `json:"decryptedPackets"`
	ParsedEvents     uint64                   `json:"parsedEvents"`
	Mouse            DiagnosticFamilyCounters `json:"mouse"`
	Keyboard         DiagnosticFamilyCounters `json:"keyboard"`
}

type DiagnosticSnapshot struct {
	Counters              DiagnosticCounters `json:"counters"`
	ActiveGrants          int                `json:"activeGrants"`
	SuspendedGrants       int                `json:"suspendedGrants"`
	PendingKeyReleases    int                `json:"pendingKeyReleases"`
	PendingButtonReleases int                `json:"pendingButtonReleases"`
}

// Diagnostics contains counts only, retained for this Manager's lifetime.
// It returns a value before the report writer acquires any of its locks.
func (m *Manager) Diagnostics() DiagnosticSnapshot {
	if m == nil {
		return DiagnosticSnapshot{}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	result := DiagnosticSnapshot{
		Counters:              m.diagnostics,
		PendingKeyReleases:    len(m.pendingKeys),
		PendingButtonReleases: len(m.pendingButtons),
	}
	for _, c := range m.connections {
		if c.grant == "" {
			continue
		}
		if c.suspended {
			result.SuspendedGrants++
		} else {
			result.ActiveGrants++
		}
	}
	return result
}

// Caller holds the Manager lock, as for the input operation itself.
func (m *Manager) inputFamily(kind string) *DiagnosticFamilyCounters {
	switch kind {
	case "move", "relative", "button", "wheel":
		return &m.diagnostics.Mouse
	case "key", "text":
		return &m.diagnostics.Keyboard
	default:
		return nil
	}
}

func (m *Manager) applyInput(b bounds, event inputEvent) error {
	family := m.inputFamily(event.Type)
	if family != nil {
		family.APIAttempts++
	}
	err := m.sink.Apply(b, event)
	if family != nil {
		if err == nil {
			family.APIAccepted++
		} else {
			family.APIRejected++
		}
	}
	return err
}
