package app

import "syscall"

func defaultConsoleLanguage() string {
	// Use the display language, not regional date/number formatting or a shell's LANG.
	language, _, _ := syscall.NewLazyDLL("kernel32.dll").NewProc("GetUserDefaultUILanguage").Call()
	return consoleLanguageFromWindowsUI(language)
}

func consoleLanguageFromWindowsUI(language uintptr) string {
	// PRIMARYLANGID: every Chinese region/script has LANG_CHINESE (0x04).
	// https://learn.microsoft.com/en-us/windows/win32/api/winnt/nf-winnt-primarylangid
	if language&0x3ff == 0x04 {
		return "zh"
	}
	return "en"
}
