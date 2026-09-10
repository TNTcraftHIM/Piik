package lan

import "testing"

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
	if _, err := Select([]string{"10.0.0.2", "192.168.1.4"}, ""); err == nil {
		t.Fatal("ambiguous selection was accepted")
	}
	if _, err := Select([]string{"10.0.0.2"}, "192.168.1.4"); err == nil {
		t.Fatal("inactive selection was accepted")
	}
}
