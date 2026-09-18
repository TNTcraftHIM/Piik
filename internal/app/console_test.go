package app

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/TNTcraftHIM/Piik/internal/diagnostics"
	"github.com/charmbracelet/x/ansi"
)

func TestConsoleRetainsTheSavedDiagnosticPathAfterRestoration(t *testing.T) {
	for _, scenario := range []string{"normal", "terminal-ended-before-export", "terminal-read-failed", "manual-result-after-terminal", "failed-export", "failed-export-keeps-path"} {
		t.Run(scenario, func(t *testing.T) {
			output, err := os.CreateTemp(t.TempDir(), "restored-terminal-")
			if err != nil {
				t.Fatal(err)
			}
			defer output.Close()
			previous := os.Stderr
			os.Stderr = output
			defer func() { os.Stderr = previous }()
			recorder, err := diagnostics.Open(t.TempDir(), "client", "test")
			if err != nil {
				t.Fatal(err)
			}
			defer recorder.Close()
			previousLogger := slog.Default()
			slog.SetDefault(recorder.Logger())
			defer slog.SetDefault(previousLogger)
			model := consoleModel{language: "en", width: 80, cancel: func() {}, view: consoleView{state: "ready"}}
			exported, release, commandDone := make(chan struct{}), make(chan struct{}), make(chan struct{})
			if scenario == "manual-result-after-terminal" {
				model.debug = consoleDebug{export: func() (string, error) {
					path, err := recorder.Export()
					close(exported)
					<-release
					close(commandDone)
					return path, err
				}}
			}
			var input io.Reader
			var failInput func()
			readFailure := errors.New("fixture terminal read failed")
			if scenario == "terminal-read-failed" {
				reader, writer := io.Pipe()
				defer reader.Close()
				defer writer.Close()
				input = reader
				failInput = func() { _ = writer.CloseWithError(readFailure) }
			}
			var screen bytes.Buffer
			console := &console{
				program: tea.NewProgram(model, tea.WithInput(input), tea.WithOutput(&screen), tea.WithoutSignalHandler(), tea.WithoutRenderer()),
				done:    make(chan consoleResult, 1),
			}
			terminalEnded := make(chan struct{})
			go func() {
				model, err := console.program.Run()
				console.done <- consoleResult{model: model, err: err}
				close(terminalEnded)
			}()
			defer console.program.Kill()
			if scenario == "manual-result-after-terminal" {
				console.send(tea.KeyPressMsg{Code: 'd'})
				select {
				case <-exported:
				case <-time.After(5 * time.Second):
					close(release)
					t.Fatal("manual export did not start")
				}
			}
			if scenario != "normal" {
				if failInput != nil {
					failInput()
				} else {
					console.program.Quit()
				}
				select {
				case <-terminalEnded:
				case <-time.After(time.Second):
					close(release)
					t.Fatal("terminal did not stop")
				}
			}
			var failure error
			if scenario == "terminal-ended-before-export" || strings.HasPrefix(scenario, "failed-export") {
				failure = errors.New("local service failed")
			}
			if scenario == "normal" || scenario == "failed-export-keeps-path" {
				path, err := recorder.Export()
				if err != nil {
					t.Fatal(err)
				}
				console.send(consoleExportResult{path: path})
			}
			if strings.HasPrefix(scenario, "failed-export") {
				if err := recorder.Close(); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "manual-result-after-terminal" {
				close(release)
				<-commandDone
			}
			failure = finishRun(console, recorder, func() { slog.SetDefault(previousLogger) }, failure)
			path := recorder.LastExportPath()
			if (path == "") != (scenario == "failed-export") {
				t.Fatalf("saved path %q does not match export outcome", path)
			}
			if scenario == "terminal-read-failed" {
				if !errors.Is(failure, readFailure) {
					t.Fatalf("terminal read failure was not retained: %v", failure)
				}
				archive, err := zip.OpenReader(path)
				if err != nil {
					t.Fatalf("terminal failure did not produce a complete diagnostic report: %v", err)
				}
				_ = archive.Close()
				log, err := os.ReadFile(recorder.LogPath())
				if err != nil || !strings.Contains(string(log), `"event":"stopped","failed":true`) ||
					!strings.Contains(string(log), readFailure.Error()) {
					t.Fatalf("final diagnostics missed the terminal error: %s, %v", log, err)
				}
			}
			content, err := os.ReadFile(output.Name())
			if err != nil || path != "" && strings.Count(string(content), path) != 1 ||
				path == "" && strings.Contains(string(content), "Saved") ||
				failure != nil && !strings.Contains(string(content), failure.Error()) {
				t.Fatalf("restored terminal lost the saved path or App error: %s, %v", content, err)
			}
		})
	}
}

func TestConsoleStartsWithSystemLanguageAndAcceptsVisualSelection(t *testing.T) {
	console := newConsole(func() {}, true)
	if console.plain.language != defaultConsoleLanguage() || console.plain.language == "vis" {
		t.Fatalf("initial console language = %q", console.plain.language)
	}
	updated, _ := console.plain.Update(consoleLanguage("vis"))
	if updated.(consoleModel).language != "vis" {
		t.Fatal("explicit visual selection was ignored")
	}
}

func TestBrowserOpenFeedbackBelongsToTheCurrentEntry(t *testing.T) {
	target := "http://127.0.0.1:8787/#client-access=private-secret"
	failure := consoleOpenResult{target: target, err: errors.New("exit status 0xc0000005")}
	model := consoleModel{width: 80, language: "en", view: consoleView{state: "ready", entry: target}}
	updated, _ := model.Update(failure)
	model = updated.(consoleModel)
	if model.finished || model.view.state != "ready" || model.view.entry != target {
		t.Fatal("browser failure retired a ready App")
	}
	for _, language := range []string{"en", "zh", "vis"} {
		updated, _ = model.Update(consoleLanguage(language))
		model = updated.(consoleModel)
		content := model.content(false)
		if !strings.Contains(content, model.text("openFailed")) || !strings.Contains(content, "0xc0000005") ||
			strings.Contains(content, "private-secret") {
			t.Fatalf("browser feedback lost its current language/error or exposed a credential: %s", content)
		}
	}
	updated, _ = model.Update(consoleOpenResult{target: target})
	model = updated.(consoleModel)
	if model.view.browserError != nil {
		t.Fatal("successful retry retained the browser failure")
	}
	for _, next := range []tea.Msg{
		consoleView{state: "setup", entry: "http://127.0.0.1:12345/client"},
		consoleView{state: "stopping"},
		consoleFinished{err: errors.New("service failed")},
	} {
		updated, _ = model.Update(next)
		updated, _ = updated.(consoleModel).Update(failure)
		if current := updated.(consoleModel); current.view.browserError != nil {
			t.Fatal("late browser result overwrote the current App state")
		}
	}
}

func TestConsoleEntryKeepsAppActivationWithoutExposingCredentials(t *testing.T) {
	model := consoleModel{width: 80, language: "en", view: consoleView{
		mode: "link", state: "ready",
		entry:  "http://user:private-secret@localhost:8787/?token=private-secret#client-access=private-secret&piik-client=1",
		invite: "https://room.example/?token=private-secret#v=private-secret",
	}}
	want := []string{"http://localhost:8787/#piik-client=1", "https://room.example/"}
	for _, styled := range []bool{false, true} {
		content := model.content(styled)
		var addresses []string
		for _, field := range strings.Fields(ansi.Strip(content)) {
			if strings.HasPrefix(field, "http") {
				addresses = append(addresses, field)
			}
		}
		if len(addresses) != len(want) {
			t.Fatalf("styled=%v: copyable addresses = %q", styled, addresses)
		}
		for i, address := range want {
			if addresses[i] != address {
				t.Fatalf("styled=%v: copyable address = %q, want %q", styled, addresses[i], address)
			}
			if styled && !strings.Contains(content, ansi.SetHyperlink(address)) {
				t.Fatalf("terminal hyperlink differs from copyable address %q", address)
			}
		}
		if strings.Contains(content, "private-secret") || strings.Contains(content, "client-access") {
			t.Fatal("console exposed an entry or invitation credential")
		}
	}
}

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

func TestConsoleBuildVersionAndRevision(t *testing.T) {
	previousVersion, previousRevision := BuildVersion, BuildRevision
	t.Cleanup(func() { BuildVersion, BuildRevision = previousVersion, previousRevision })
	BuildRevision = strings.Repeat("a", 40)
	for _, test := range []struct{ version, want string }{
		{"v1.2.3", "v1.2.3"},
		{"development", "development"},
		{"", "development"},
		{"v01.2.3", "development"},
		{"v1.2", "development"},
		{"v1.2.3-preview.1", "development"},
		{"v1.2.3+build", "development"},
	} {
		BuildVersion = test.version
		content := (consoleModel{width: 80, language: "en", view: consoleView{state: "ready"}}).content(false)
		if !strings.Contains(content, test.want) || !strings.Contains(content, "aaaaaaa") || strings.Contains(content, BuildRevision) {
			t.Fatalf("console identity for %q: %s", test.version, content)
		}
	}
}

func TestConsoleDiagnosticExportRunsOutsideUpdate(t *testing.T) {
	called := 0
	path := filepath.Join(t.TempDir(), "client-report.zip")
	model := consoleModel{
		view: consoleView{state: "ready"}, frame: 16, idlePending: true,
		debug: consoleDebug{logPath: filepath.Join(filepath.Dir(path), "client.log"), export: func() (string, error) {
			called++
			return path, nil
		}},
	}
	updated, command := model.Update(tea.KeyPressMsg{Code: 'd'})
	model = updated.(consoleModel)
	if called != 0 || command == nil || !model.exporting {
		t.Fatal("diagnostic export blocked the console update")
	}
	_, repeated := model.Update(tea.KeyPressMsg{Code: 'd'})
	if repeated != nil {
		t.Fatal("repeated key queued another diagnostic export")
	}
	updated, _ = model.Update(command())
	model = updated.(consoleModel)
	if called != 1 || model.exporting || model.exportPath != path || model.exportError {
		t.Fatalf("diagnostic result = %+v", model)
	}
	updated, _ = model.Update(consoleExportResult{err: errors.New("disk full")})
	model = updated.(consoleModel)
	if !model.exportError || model.exportPath != path {
		t.Fatal("failed export discarded the previously saved bundle")
	}
	for _, language := range []string{"en", "zh", "vis"} {
		for _, width := range []int{30, 52, 90} {
			model.language, model.width, model.height = language, width, 40
			for _, styled := range []bool{false, true} {
				content := model.content(styled)
				for _, line := range strings.Split(content, "\n") {
					if ansi.StringWidth(line) > width {
						t.Fatalf("%s diagnostic console width %d overflowed: %q", language, width, line)
					}
				}
				if styled && !strings.Contains(content, "[d]") || !styled && strings.Contains(content, "[d]") {
					t.Fatalf("export key hint does not match terminal input: %q", content)
				}
			}
		}
	}
	link := consoleFileLink(path, path, lipgloss.NewStyle(), true)
	if !strings.Contains(link, "file:///") || strings.Contains(link, "file:///C:\\") {
		t.Fatalf("local report hyperlink = %q", link)
	}
}

func TestConsoleDiagnosticsFitCompactTerminal(t *testing.T) {
	model := consoleModel{
		view:  consoleView{mode: "local", state: "ready", entry: "http://localhost:8787/"},
		width: 30, height: 18, colors: true,
		debug: consoleDebug{logPath: "C:/Piik/logs/client.log", export: func() (string, error) { return "", nil }},
	}
	for _, language := range []string{"en", "zh", "vis"} {
		model.language = language
		for _, path := range []string{"", "C:/Piik/logs/client-20260908T120000Z.zip", "C:/Users/Example/Documents/Workspaces/Piik-embedded-media/build/client-check/logs/client-diagnostics-20260908T120000Z-123456789.zip"} {
			model.exportPath = path
			content := model.content(true)
			if lipgloss.Width(content) > model.width || lipgloss.Height(content) > model.height {
				t.Fatalf("%s diagnostic console overflowed: %s", language, content)
			}
			if !strings.Contains(content, "[d]") || !strings.Contains(content, "[o]") || !strings.Contains(content, "[q") {
				t.Fatalf("compact diagnostics hid a terminal action: %s", content)
			}
		}
	}
}
