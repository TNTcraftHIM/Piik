//go:build !windows

package roomeffects

import (
	"context"
	"errors"

	"github.com/TNTcraftHIM/Piik/internal/server/signal"
)

func runOverlay(context.Context, Options, <-chan signal.RoomEffect) error {
	return errors.New("desktop danmaku requires Windows")
}

func runSpeech(context.Context, <-chan signal.RoomEffect) error {
	return errors.New("join announcements require Windows")
}
