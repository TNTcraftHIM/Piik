package app

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/TNTcraftHIM/Piik/internal/app/browser"
	"github.com/TNTcraftHIM/Piik/internal/app/failure"
	"github.com/TNTcraftHIM/Piik/internal/diagnostics"
	"github.com/charmbracelet/colorprofile"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/term"
)

type consoleView struct {
	mode, state, entry, invite string
	protected                  bool
	problem                    error
	browserError               error
}

type consoleLanguage string
type consoleLauncher string
type consoleFinished struct{ err error }
type consoleTick struct{}
type consoleIdleWink struct{}
type consoleOpenResult struct {
	target string
	err    error
}
type consoleDiagnostic string

func (diagnostic consoleDiagnostic) Error() string { return string(diagnostic) }

type consoleDebug struct {
	logPath string
	export  func() (string, error)
}
type consoleExportResult struct {
	path string
	err  error
}

type consoleResult struct {
	model tea.Model
	err   error
}

type consoleModel struct {
	view        consoleView
	launcher    string
	language    string
	width       int
	height      int
	colors      bool
	frame       int
	tickPending bool
	idlePending bool
	idleWink    bool
	finished    bool
	cancel      context.CancelFunc
	debug       consoleDebug
	exporting   bool
	exportPath  string
	exportError bool
	openBrowser func(string)
}

type console struct {
	mu       sync.Mutex
	machine  bool
	finished bool
	program  *tea.Program
	done     chan consoleResult
	plain    consoleModel
	opening  bool
	openURL  func(string) error
}

var consoleCopy = map[string][3]string{
	"failure.tunnel-exited":      {"Public invite disconnected before it was ready. Try again or use an existing Piik site.", "公网邀请尚未就绪就已断开，请重试或使用已有 Piik 站点。", "!"},
	"failure.tunnel-timeout":     {"Public invite did not connect in time. Try again or use an existing Piik site.", "公网邀请连接超时，请重试或使用已有 Piik 站点。", "!"},
	"failure.tunnel-unavailable": {"The public-invite helper is unavailable. Extract the complete App package again.", "公网邀请辅助程序不可用，请重新完整解压 App 程序包。", "!"},
	"failure.tunnel-start":       {"Could not start public invite. Check the details or use an existing Piik site.", "无法启动公网邀请，请查看详情或使用已有 Piik 站点。", "!"},
	"failure.tunnel-stopped":     {"Public invite stopped. Reopen App for a new link or use an existing Piik site.", "公网邀请已停止，请重开 App 获取新链接，或使用已有 Piik 站点。", "!"},
	"failure.local-port":         {"The local port is unavailable. Close the other process or choose another port.", "本地端口不可用，请关闭占用程序或更换端口。", "!"},
	"failure.local-network":      {"No suitable local invitation address. Check your network and selected address.", "没有合适的局域网邀请地址，请检查网络和所选地址。", "!"},
	"failure.configuration":      {"Could not apply App settings. Check the details.", "无法应用 App 设置，请查看详情。", "!"},
	"failure.native-control":     {"App connection service is unavailable. Reopen App and try again.", "App 连接服务不可用，请重开 App 后重试。", "!"},
	"failure.launcher":           {"App launcher is unavailable. Reopen App and try again.", "App 启动页不可用，请重开 App 后重试。", "!"},
	"failure.diagnostics":        {"Could not start diagnostics. Check the save location and permissions.", "无法开启诊断，请检查保存位置与权限。", "!"},
	"failure.local-server":       {"The local room service is unavailable. Check the details.", "本地房间服务不可用，请查看详情。", "!"},
	"local":                      {"Local network", "局域网", "□"},
	"link":                       {"Public link", "公网链接", "↗"},
	"site":                       {"Piik Site", "Piik 站点", "@"},
	"setup":                      {"App is ready", "App 已就绪", "?"},
	"starting":                   {"Starting", "正在启动", "…"},
	"ready":                      {"Ready", "已就绪", "✓"},
	"stopping":                   {"Stopping", "正在退出", "→"},
	"stopped":                    {"Stopped", "已停止", "○"},
	"failed":                     {"Could not continue", "运行失败", "!"},
	"entry":                      {"Open in browser", "打开网页", "□"},
	"launcher":                   {"App launcher", "App 启动页", "☆"},
	"invite":                     {"Site address", "站点地址", "↗"},
	"access":                     {"Site access", "站点准入", ""},
	"open":                       {"Open", "开放", "○"},
	"password":                   {"Password protected", "已设置密码", "*"},
	"error":                      {"Details", "详情", "!"},
	"exit":                       {"quit", "退出", "↪"},
	"openFailed":                 {"Could not open the browser; use the address above.", "无法打开浏览器，请使用上方地址。", "! ↗"},
	"log":                        {"Log", "日志", ""},
	"export":                     {"Export diagnostics", "导出诊断", ""},
	"exporting":                  {"Saving diagnostics", "正在保存诊断", ""},
	"exported":                   {"Saved", "已保存", ""},
	"exportFailed":               {"Could not save diagnostics", "无法保存诊断", ""},
}

func newConsole(cancel context.CancelFunc, machine bool) *console {
	console := &console{
		machine: machine,
		openURL: browser.Open,
		plain: consoleModel{view: consoleView{state: "starting"}, language: defaultConsoleLanguage(), width: 76, cancel: cancel,
			colors: colorprofile.Detect(os.Stdout, os.Environ()) > colorprofile.ASCII},
	}
	console.plain.openBrowser = console.openBrowser
	if machine {
		return console
	}
	if term.IsTerminal(os.Stdin.Fd()) && term.IsTerminal(os.Stdout.Fd()) && os.Getenv("TERM") != "dumb" {
		console.program = tea.NewProgram(console.plain, tea.WithoutSignalHandler())
		console.done = make(chan consoleResult, 1)
		go func() {
			model, err := console.program.Run()
			console.done <- consoleResult{model: model, err: err}
			cancel()
		}()
	}
	return console
}

func (console *console) send(message tea.Msg) {
	console.mu.Lock()
	defer console.mu.Unlock()
	if console.machine || console.finished {
		return
	}
	if _, finished := message.(consoleFinished); finished {
		console.finished = true
	}
	if console.program != nil {
		console.program.Send(message)
		return
	}
	updated, _ := console.plain.Update(message)
	console.plain = updated.(consoleModel)
	fmt.Fprintln(os.Stdout, console.plain.content(false))
}

func (console *console) show(view consoleView)       { console.send(view) }
func (console *console) setLanguage(language string) { console.send(consoleLanguage(language)) }

// One OS handoff may remain pending, but never blocks App readiness or exit.
// Do not kill the handler on a timer: it may itself own the user's browser.
func (console *console) openBrowser(target string) {
	console.mu.Lock()
	if console.finished || console.opening {
		console.mu.Unlock()
		return
	}
	console.opening = true
	openURL := console.openURL
	console.mu.Unlock()
	go func() {
		err := openURL(target)
		if err != nil {
			slog.Debug("Could not open the system browser", diagnostics.Error(err))
		}
		console.send(consoleOpenResult{target: target, err: err})
		console.mu.Lock()
		console.opening = false
		console.mu.Unlock()
	}()
}

func (console *console) stop(err error) error {
	if console.program == nil {
		return nil
	}
	console.send(consoleFinished{err})
	result := <-console.done
	if model, ok := result.model.(consoleModel); ok {
		console.plain.language = model.language
	}
	return result.err
}

func (console *console) finish(err error, exportPath string) {
	if console.program == nil {
		console.send(consoleFinished{err})
		return
	}
	if exportPath != "" {
		fmt.Fprintln(os.Stderr, "Piik App:", console.plain.text("exported"), exportPath)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Piik App:", err)
	}
}

func (console *console) logWriter() io.Writer {
	if console.program == nil {
		return os.Stderr
	}
	return console
}

func (console *console) Write(data []byte) (int, error) {
	if text := strings.TrimSpace(string(data)); text != "" {
		console.send(consoleDiagnostic(ansi.Strip(text)))
	}
	return len(data), nil
}

func (model consoleModel) Init() tea.Cmd { return nil }

func (model consoleModel) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch value := message.(type) {
	case consoleView:
		if model.view.state != "stopping" {
			model.view = value
		}
	case consoleLanguage:
		model.language = string(value)
	case consoleLauncher:
		model.launcher = string(value)
	case consoleDiagnostic:
		model.view.problem = value
		model.view.browserError = nil
	case consoleDebug:
		model.debug = value
	case consoleExportResult:
		model.exporting, model.exportError = false, value.err != nil
		if value.err == nil {
			model.exportPath = value.path
		}
	case tea.WindowSizeMsg:
		model.width, model.height = value.Width, value.Height
	case tea.ColorProfileMsg:
		model.colors = value.Profile > colorprofile.ASCII
	case consoleTick:
		model.tickPending = false
		model.frame++
		if model.frame >= 16 {
			model.idleWink = false
		}
	case consoleIdleWink:
		model.idlePending = false
		if model.view.state == "ready" || model.view.state == "setup" {
			model.frame, model.idleWink = 8, true
		}
	case consoleOpenResult:
		if value.target == model.view.entry && !model.finished && model.view.state != "stopping" {
			model.view.browserError = value.err
		}
	case consoleFinished:
		model.finished = true
		model.view.entry, model.view.invite, model.launcher = "", "", ""
		model.view.browserError = nil
		model.view.state, model.view.problem = "stopped", nil
		if value.err != nil {
			model.view.state, model.view.problem = "failed", value.err
		}
		return model, tea.Quit
	case tea.KeyPressMsg:
		switch value.String() {
		case "q", "ctrl+c":
			model.view = consoleView{mode: model.view.mode, state: "stopping"}
			model.launcher = ""
			model.cancel()
		case "o", "O":
			if target := model.view.entry; target != "" && model.openBrowser != nil {
				return model, func() tea.Msg { model.openBrowser(target); return nil }
			}
		case "d", "D":
			if model.debug.export != nil && !model.exporting && !model.finished && model.view.state != "stopping" {
				model.exporting, model.exportError = true, false
				return model, func() tea.Msg {
					path, err := model.debug.export()
					return consoleExportResult{path: path, err: err}
				}
			}
		}
	}
	if model.animating() && !model.tickPending {
		model.tickPending = true
		return model, tea.Tick(200*time.Millisecond, func(time.Time) tea.Msg { return consoleTick{} })
	}
	if !model.finished && !model.animating() && !model.idlePending &&
		(model.view.state == "ready" || model.view.state == "setup") {
		model.idlePending = true
		return model, tea.Tick(time.Duration(8+rand.IntN(13))*time.Second, func(time.Time) tea.Msg { return consoleIdleWink{} })
	}
	return model, nil
}

func (model consoleModel) animating() bool {
	return !model.finished && model.view.state != "stopping" &&
		(model.view.state == "starting" || model.frame < 8 || model.idleWink)
}

func (model consoleModel) text(key string) string {
	index := 0
	if model.language == "zh" {
		index = 1
	}
	if model.language == "vis" {
		return consoleVisualToken(key)
	}
	return consoleCopy[key][index]
}

func (model consoleModel) View() tea.View {
	view := tea.NewView(model.content(true))
	view.WindowTitle = "Piik App"
	view.AltScreen = true
	return view
}

func (model consoleModel) content(styled bool) string {
	width := max(12, min(model.width-2, 74))
	compact := model.height > 0 && model.height < 24
	compactDebug := compact && model.debug.logPath != ""
	visual := model.language == "vis"
	accent, muted, link, rule := lipgloss.NewStyle(), lipgloss.NewStyle(), lipgloss.NewStyle(), lipgloss.NewStyle()
	if styled {
		accent = accent.Bold(true)
		muted = muted.Faint(true)
		link = link.Underline(true)
	}
	key, stateStyle := accent, accent
	if styled && model.colors {
		// Use the terminal's palette so light and dark terminal themes both work.
		link = link.Foreground(lipgloss.Color("12"))
		key = key.Foreground(lipgloss.Color("12"))
		rule = rule.Foreground(lipgloss.Color("8"))
		switch model.view.state {
		case "ready", "setup":
			stateStyle = stateStyle.Foreground(lipgloss.Color("10"))
		case "starting", "stopping":
			stateStyle = stateStyle.Foreground(lipgloss.Color("11"))
		case "failed":
			stateStyle = stateStyle.Foreground(lipgloss.Color("9"))
		}
	}
	revision := BuildRevision
	if len(revision) == 40 {
		revision = revision[:7]
	}
	var out strings.Builder
	version := buildVersion()
	heading := accent.Render("Piik App") + "\n" + muted.Render(version)
	if revision != "" && revision != version {
		heading += "\n" + muted.Render(revision)
	}
	animated := styled && model.animating()
	mascot := accent.Render(consoleTV(model.frame, animated, compact || width < 34))
	if styled && model.colors && width >= 36 && !compact {
		mascot = consoleBlockTV(model.frame, animated)
	}
	fmt.Fprintln(&out, lipgloss.JoinHorizontal(lipgloss.Center, mascot, "  ", heading))
	if styled && !compact {
		fmt.Fprintln(&out, rule.Render(strings.Repeat("─", width-4)))
	} else {
		fmt.Fprintln(&out)
	}
	state := model.text(model.view.state)
	if model.view.state == "starting" && !visual {
		dots := 3
		if styled {
			dots = model.frame%3 + 1
		}
		state += strings.Repeat(".", dots)
	}
	if visual {
		// Keep visual mode one line tall; multi-line scene art side by side
		// collapses on narrow terminals and reads like missing characters.
		fmt.Fprintln(&out, lipgloss.JoinHorizontal(lipgloss.Center,
			accent.Render(consoleVisualToken(model.view.mode)), " · ",
			stateStyle.Render(consoleVisualToken(model.view.state))))
	} else {
		statusLine := stateStyle.Render(state)
		if model.view.mode != "" {
			statusLine += muted.Render("  ·  ") + model.text(model.view.mode)
		}
		fmt.Fprintln(&out, ansi.Wrap(statusLine, width-4, ""))
	}
	for _, item := range [][2]string{{"entry", model.view.entry}, {"launcher", model.launcher}, {"invite", model.view.invite}} {
		if item[1] == "" || compact && item[0] == "invite" || item[0] == "launcher" && item[1] == model.view.entry {
			continue
		}
		address := consoleAddress(item[1])
		if item[0] == "entry" {
			address = launchURL(address)
		}
		style := link
		if styled {
			style = style.Hyperlink(address)
		}
		if compactDebug {
			fmt.Fprintf(&out, "\n%s\n", style.Render(address))
		} else if visual {
			label := consoleVisualToken(item[0])
			fmt.Fprintf(&out, "\n%s %s\n", label, style.Render(address))
		} else {
			fmt.Fprintf(&out, "\n%s\n%s\n", muted.Render(model.text(item[0])), style.Render(address))
		}
	}
	accessPicture := ""
	if !compact && model.view.entry != "" && (model.view.mode == "local" || model.view.mode == "link") {
		access := "open"
		if model.view.protected {
			access = "password"
		}
		if visual {
			accessPicture = consoleVisualToken(access) + "   "
		} else {
			fmt.Fprintf(&out, "\n%s  %s\n", muted.Render(model.text("access")), model.text(access))
		}
	}
	problem := ""
	if model.view.problem != nil {
		problem = diagnostics.SafeText(model.view.problem.Error())
		if _, diagnostic := model.view.problem.(consoleDiagnostic); !diagnostic {
			if reason := failure.Of(model.view.problem); reason != "" {
				fmt.Fprintf(&out, "\n%s\n", ansi.Hardwrap(model.text("failure."+string(reason)), width-4, true))
			} else if model.view.state != "failed" {
				fmt.Fprintf(&out, "\n%s\n", model.text("failed"))
			}
		}
	}
	if model.view.browserError != nil {
		problem = model.text("openFailed") + "\n" + model.view.browserError.Error()
	}
	if problem != "" {
		lines := strings.Split(ansi.Hardwrap(ansi.Strip(problem), width-4, true), "\n")
		if len(lines) > 3 {
			lines = append(lines[:2], "...")
		}
		fmt.Fprintf(&out, "\n%s\n%s\n", model.text("error"), strings.Join(lines, "\n"))
	}
	if model.debug.logPath != "" {
		path, label := model.debug.logPath, "log"
		if model.exportPath != "" {
			path, label = model.exportPath, "exported"
		}
		separator := "\n"
		if compactDebug {
			separator = " "
		}
		fmt.Fprintf(&out, "\n%s%s%s\n", muted.Render(model.text(label)), separator, consoleFileLink(path, path, link, styled))
		if model.exporting {
			fmt.Fprintln(&out, model.text("exporting"))
		} else if model.exportError {
			fmt.Fprintln(&out, model.text("exportFailed"))
		}
	}
	if !model.finished {
		keys := key.Render("[q / Ctrl+C]")
		if !styled {
			keys = "Ctrl+C"
		}
		help := keys + " " + muted.Render(model.text("exit"))
		if visual {
			if model.view.entry != "" && styled {
				help = key.Render("[o]") + " ↗    " + help
			}
			help = lipgloss.JoinHorizontal(lipgloss.Center, accessPicture, help)
		} else if model.view.entry != "" && styled {
			separator := "    "
			if compact {
				separator = "\n"
			}
			help = key.Render("[o]") + " " + muted.Render(model.text("entry")) + separator + help
		}
		if model.debug.export != nil && styled {
			help = key.Render("[d]") + " " + muted.Render(model.text("export")) + "\n" + help
		}
		fmt.Fprintf(&out, "\n%s", help)
	}
	content := ansi.Hardwrap(out.String(), width-4, true)
	if !styled {
		return content
	}
	padding := 1
	if model.height > 0 && lipgloss.Height(content)+4 > model.height {
		content = strings.ReplaceAll(content, "\n\n", "\n")
		padding = 0
	}
	return lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(rule.GetForeground()).
		Padding(padding, 1).Width(width).Render(content)
}

func consoleVisualToken(key string) string {
	switch key {
	case "local":
		return "□"
	case "link":
		return "↗"
	case "site":
		return "@"
	case "setup":
		return "?"
	case "starting":
		return "…"
	case "ready":
		return "✓"
	case "stopping":
		return "→"
	case "stopped":
		return "○"
	case "failed", "error":
		return "!"
	case "openFailed":
		return "! ↗"
	case "open":
		return "○"
	case "password":
		return "*"
	case "entry":
		return "□"
	case "launcher":
		return "☆"
	case "invite":
		return "↗"
	case "exit":
		return "↪"
	case "log":
		return "LOG"
	case "export":
		return "ZIP"
	case "exporting":
		return "ZIP ..."
	case "exported":
		return "ZIP +"
	case "exportFailed":
		return "ZIP !"
	default:
		return "?"
	}
}

func consoleTV(frame int, animated, compact bool) string {
	phase := 0
	if animated {
		phase = frame % 8
	}
	eye := "o"
	if !animated || phase >= 4 {
		eye = "-"
	}
	if compact {
		return "  \\ /     \n [o  " + eye + "]   \n  /  \\     "
	}
	stars := [3]string{" ", " ", " "}
	if phase == 5 {
		stars[2] = "*"
	}
	if phase == 6 {
		stars[1] = "+"
	}
	if phase == 7 {
		stars[0] = "."
	}
	lines := []string{
		"     \\ /     " + stars[0] + " ",
		" .----v----.  " + stars[1] + " ",
		" | o     " + eye + " |  " + stars[2] + " ",
		" '---------'    ",
		"   /     \\      ",
	}
	return strings.Join(lines, "\n")
}

func consoleBlockTV(frame int, animated bool) string {
	phase := 0
	if animated {
		phase = frame % 8
	}
	shell := lipgloss.NewStyle().Reverse(true)
	spark := lipgloss.NewStyle().Foreground(lipgloss.Color("#f4c14d")).Faint(phase == 7)
	// Digits reveal the shell clockwise before the face; subsequent loops keep it drawn.
	rows := []string{"  2   2  ", "   2 2   ", " 0000011 ", "3sssssss1", "3sessses1", "3sssssss1", " 3222222 ", "  3   3  "}
	lines := make([]string, 0, len(rows))
	for rowIndex, row := range rows {
		var line strings.Builder
		for column, pixel := range row {
			if animated && (pixel >= '0' && pixel <= '3' && frame < int(pixel-'0') || (pixel == 's' || pixel == 'e') && frame < 3) {
				pixel = ' '
			}
			switch pixel {
			case '0', '1', '2', '3':
				line.WriteString(shell.Render("  "))
			case 's':
				line.WriteString("  ")
			case 'e':
				if column == len(row)-3 && (!animated || phase >= 4) {
					line.WriteString("\u2584\u2584")
				} else {
					line.WriteString(shell.Render("  "))
				}
			default:
				line.WriteString("  ")
			}
		}
		star := "   "
		starStyle := spark
		switch {
		case phase == 5 && rowIndex == 4:
			star = "\u2584\u2588\u2584"
		case phase == 5 && rowIndex == 5:
			star, starStyle = "\u2584 \u2584", spark.Reverse(true)
		case phase == 6 && rowIndex == 2:
			star = " \u2584 "
		case phase == 7 && rowIndex == 1:
			star = "  ."
		}
		lines = append(lines, line.String()+starStyle.Render(star))
	}
	return strings.Join(lines, "\n")
}

func consoleAddress(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	parsed.User, parsed.RawQuery, parsed.Fragment, parsed.RawFragment, parsed.ForceQuery = nil, "", "", "", false
	return parsed.String()
}

func consoleFileLink(path, label string, style lipgloss.Style, styled bool) string {
	if !styled {
		return label
	}
	path = filepath.ToSlash(path)
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	address := url.URL{Scheme: "file", Path: path}
	return style.Hyperlink(address.String()).Render(label)
}
