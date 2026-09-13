package main

import "testing"

func TestCommandExitStatus(t *testing.T) {
	for _, test := range []struct {
		name string
		args []string
		want int
	}{
		{"help", []string{"--help"}, 0},
		{"unknown flag", []string{"--not-a-piik-option"}, 2},
		{"invalid port", []string{"--port", "invalid"}, 2},
		{"startup failure", []string{"--local", "--link"}, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("PIIK_CLIENT_GATE_NO_BROWSER", "true")
			if got := run(test.args); got != test.want {
				t.Fatalf("exit status = %d, want %d", got, test.want)
			}
		})
	}
}
