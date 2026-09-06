package browser

import (
	"reflect"
	"testing"
)

func TestCommandUsesThePlatformURLLauncher(t *testing.T) {
	tests := []struct {
		platform string
		command  string
		args     []string
	}{
		{"windows", "rundll32.exe", []string{"url.dll,FileProtocolHandler", "https://share.example/room"}},
		{"darwin", "open", []string{"https://share.example/room"}},
		{"linux", "xdg-open", []string{"https://share.example/room"}},
	}
	for _, test := range tests {
		commandName, args, err := command(test.platform, "https://share.example/room")
		if err != nil || commandName != test.command || !reflect.DeepEqual(args, test.args) {
			t.Fatalf("command(%s) = %q, %#v, %v", test.platform, commandName, args, err)
		}
	}
}

func TestCommandRejectsNonWebTargetsAndUnknownPlatforms(t *testing.T) {
	if _, _, err := command("windows", "file:///tmp/index.html"); err == nil {
		t.Fatal("file URL was accepted")
	}
	if _, _, err := command("plan9", "https://share.example"); err == nil {
		t.Fatal("unknown platform was accepted")
	}
}
