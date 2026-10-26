package remoteinput

import (
	"errors"
	"strings"
	"unicode/utf8"
)

const maxTextBytes = 2048
const maxInputBytes = maxTextBytes*2 + 256 // JSON escaping and grant fields.

// Text is one explicit submission. Newlines and tabs use real keys on every
// platform; Unicode events handle the remaining text independently of layout.
type textSink interface {
	Reset() error
	Apply(bounds, inputEvent) error
}

func applyText(sink textSink, target bounds, text string) error {
	if text == "" || len(text) > maxTextBytes || !utf8.ValidString(text) {
		return errors.New("invalid input text")
	}
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
	for _, r := range text {
		if r < 0x20 && r != '\n' && r != '\t' || r == 0x7f {
			return errors.New("text contains a control character")
		}
	}
	if err := sink.Reset(); err != nil {
		return err
	}
	for text != "" {
		end := strings.IndexAny(text, "\n\t")
		if end < 0 {
			return sink.Apply(target, inputEvent{Type: "text", Text: text})
		}
		if end > 0 {
			if err := sink.Apply(target, inputEvent{Type: "text", Text: text[:end]}); err != nil {
				return err
			}
		}
		code := "Enter"
		if text[end] == '\t' {
			code = "Tab"
		}
		for _, down := range []bool{true, false} {
			if err := sink.Apply(target, inputEvent{Type: "key", Code: code, Down: down}); err != nil {
				return err
			}
		}
		text = text[end+1:]
	}
	return nil
}
