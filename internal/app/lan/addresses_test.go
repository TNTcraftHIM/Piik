package lan

import (
	"strings"
	"testing"
)

func TestSelectUsesOneAddressOrAnExplicitActiveAddress(t *testing.T) {
	if selected, err := Select([]string{"192.168.1.4"}, ""); err != nil || selected != "192.168.1.4" {
		t.Fatalf("single selection = %q, %v", selected, err)
	}
	if selected, err := Select([]string{"10.0.0.2", "192.168.1.4"}, "192.168.1.4"); err != nil || selected != "192.168.1.4" {
		t.Fatalf("explicit selection = %q, %v", selected, err)
	}
	if selected, err := Select([]string{"192.168.1.4", "198.18.0.1"}, ""); err != nil || selected != "192.168.1.4" {
		t.Fatalf("private LAN selection = %q, %v", selected, err)
	}
	if _, err := Select([]string{"10.0.0.2", "192.168.1.4"}, ""); err == nil ||
		!strings.Contains(err.Error(), "--local --lan-address <address>") {
		t.Fatalf("ambiguous selection must explain the actual CLI option: %v", err)
	}
	if _, err := Select([]string{"10.0.0.2"}, "192.168.1.4"); err == nil {
		t.Fatal("inactive selection was accepted")
	}
}

func TestSelectReportsNoAvailableAddress(t *testing.T) {
	selected, err := Select(nil, "")
	if selected != "" || err == nil || err.Error() != "no active LAN IPv4 address is available" {
		t.Fatalf("empty selection must explain the missing LAN address: %q, %v", selected, err)
	}
}
