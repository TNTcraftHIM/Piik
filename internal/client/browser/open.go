package browser

import (
	"errors"
	"net/url"
	"os/exec"
	"runtime"
)

func Open(target string) error {
	command, arguments, err := command(runtime.GOOS, target)
	if err != nil {
		return err
	}
	return exec.Command(command, arguments...).Run()
}

func command(platform, target string) (string, []string, error) {
	parsed, err := url.Parse(target)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", nil, errors.New("Browser URL is invalid")
	}
	switch platform {
	case "windows":
		return "rundll32.exe", []string{"url.dll,FileProtocolHandler", parsed.String()}, nil
	case "darwin":
		return "open", []string{parsed.String()}, nil
	case "linux":
		return "xdg-open", []string{parsed.String()}, nil
	default:
		return "", nil, errors.New("Browser launch is unsupported on this platform")
	}
}
