package app

import "testing"

func TestConsoleWindowsUILanguage(t *testing.T) {
	for _, test := range []struct {
		name string
		id   uintptr
		want string
	}{
		{"zh-CN", 0x0804, "zh"}, {"zh-TW", 0x0404, "zh"},
		{"zh-Hant", 0x7c04, "zh"}, {"zh-HK", 0x0c04, "zh"},
		{"zh-SG", 0x1004, "zh"}, {"en-US", 0x0409, "en"},
		{"ja-JP", 0x0411, "en"}, {"unknown", 0, "en"},
	} {
		if got := consoleLanguageFromWindowsUI(test.id); got != test.want {
			t.Errorf("%s = %q, want %q", test.name, got, test.want)
		}
	}
	actual := defaultConsoleLanguage()
	if actual != "zh" && actual != "en" {
		t.Fatalf("Windows display language produced %q", actual)
	}
	t.Logf("Actual Windows console language: %s", actual)
}
