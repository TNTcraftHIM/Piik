//go:build !windows

package app

import "testing"

func TestConsoleLocaleEnvironment(t *testing.T) {
	for _, test := range []struct {
		all, messages, lang, preferred, want string
	}{
		{lang: "zh_CN.UTF-8", want: "zh"},
		{lang: "zh_TW.UTF-8", want: "zh"},
		{lang: "zh-Hant", want: "zh"},
		{lang: "ja_JP.UTF-8", want: "en"},
		{lang: "vis", want: "en"},
		{messages: "zh_HK.UTF-8", lang: "en_US.UTF-8", want: "zh"},
		{all: "en_US.UTF-8", messages: "zh_CN.UTF-8", want: "en"},
		{lang: "en_US.UTF-8", preferred: "zh_TW:en", want: "zh"},
		{lang: "C.UTF-8", preferred: "zh_TW:en", want: "en"},
		{all: "POSIX", messages: "zh_CN.UTF-8", want: "en"},
		{preferred: "zh_TW:en", want: "en"},
		{want: "en"},
	} {
		t.Setenv("LC_ALL", test.all)
		t.Setenv("LC_MESSAGES", test.messages)
		t.Setenv("LANG", test.lang)
		t.Setenv("LANGUAGE", test.preferred)
		if got := defaultConsoleLanguage(); got != test.want {
			t.Errorf("locale %+v = %q", test, got)
		}
	}
}
