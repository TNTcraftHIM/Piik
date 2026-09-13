//go:build !windows

package app

import (
	"os"
	"strings"
)

func defaultConsoleLanguage() string {
	var locale string
	for _, name := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		if locale = os.Getenv(name); locale != "" {
			break
		}
	}
	// GNU's message-language preference applies only outside the C/POSIX locale.
	if locale == "" || locale == "C" || locale == "POSIX" || strings.HasPrefix(locale, "C.") {
		return "en"
	}
	if preferred, _, _ := strings.Cut(os.Getenv("LANGUAGE"), ":"); preferred != "" {
		locale = preferred
	}
	if end := strings.IndexAny(locale, "_-.@"); end >= 0 {
		locale = locale[:end]
	}
	if strings.EqualFold(locale, "zh") {
		return "zh"
	}
	return "en"
}
