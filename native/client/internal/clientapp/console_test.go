package clientapp

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

func TestConsolePresentationAndShutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	model := consoleModel{cancel: cancel, view: consoleView{
		mode: "link", state: "ready", protected: true,
		entry:  "http://localhost:8787/#client-access=private-secret",
		invite: "https://a-long-public-link-name.example.test/",
	}}
	for _, language := range []string{"zh", "en", "vis"} {
		for _, width := range []int{30, 52, 90} {
			model.language, model.width, model.height = language, width, 18
			for _, styled := range []bool{true, false} {
				content := model.content(styled)
				if styled && strings.Count(content, "\n")+1 > model.height {
					t.Fatalf("%s width %d height overflow: %d", language, width, strings.Count(content, "\n")+1)
				}
				if strings.Contains(content, "private-secret") || strings.Contains(content, "client-access") {
					t.Fatal("console exposed the entry credential")
				}
				for _, line := range strings.Split(content, "\n") {
					if ansi.StringWidth(line) > width {
						t.Fatalf("%s width %d overflow: %q", language, width, line)
					}
				}
			}
		}
	}
	model.colors = true
	for _, compact := range []bool{false, true} {
		model.width, model.height = 80, 32
		if compact {
			model.width, model.height = 40, 18
		}
		for _, frame := range []int{0, 3, 5, 8} {
			mascot := consoleBlockTV(frame, true)
			lines := strings.Split(mascot, "\n")
			if len(lines) != len(strings.Split(consoleBlockTV(0, false), "\n")) {
				t.Fatal("mascot animation moved the layout")
			}
			for _, line := range lines {
				if ansi.StringWidth(line) != ansi.StringWidth(lines[0]) {
					t.Fatal("mascot frame changed width")
				}
			}
			model.frame = frame
			content := model.content(true)
			if lipgloss.Width(content) > model.width || lipgloss.Height(content) > model.height {
				t.Fatal("color console overflowed")
			}
		}
	}
	if !strings.Contains(consoleTV(5, true, false), "- |  *") ||
		!strings.Contains(consoleTV(0, false, false), "o     -") ||
		!strings.Contains(consoleBlockTV(0, false), "\u2584\u2584") ||
		consoleTV(8, false, false) != consoleTV(0, false, false) {
		t.Fatal("mascot wink or static state changed")
	}
	model.frame = 16
	updated, cmd := model.Update(consoleIdleWink{})
	waking := updated.(consoleModel)
	if !waking.animating() || waking.frame != 8 || cmd == nil {
		t.Fatal("idle wink did not resume without redrawing the shell")
	}
	for range 8 {
		updated, _ = waking.Update(consoleTick{})
		waking = updated.(consoleModel)
	}
	if waking.animating() || !waking.idlePending {
		t.Fatal("idle wink did not return to rest")
	}
	var output bytes.Buffer
	program := tea.NewProgram(model, tea.WithInput(nil), tea.WithOutput(&output), tea.WithoutSignalHandler(), tea.WithoutRenderer())
	done := make(chan error, 1)
	go func() { _, err := program.Run(); done <- err }()
	program.Send(consoleLanguage("zh"))
	program.Send(tea.KeyPressMsg{Code: 'q'})
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("quit did not request application shutdown")
	}
	program.Send(consoleFinished{})
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		program.Kill()
		t.Fatal("console did not finish after application cleanup")
	}
	updated, _ = model.Update(consoleFinished{})
	if text := updated.(consoleModel).content(false); strings.Contains(text, "http") {
		t.Fatal("stopped console retained a live entry")
	}
}
