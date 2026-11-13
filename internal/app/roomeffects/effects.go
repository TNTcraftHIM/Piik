package roomeffects

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"github.com/TNTcraftHIM/Piik/internal/server/signal"
)

type Options struct {
	Danmaku, AnnounceJoin bool
	Size, Speed, Opacity  float64
	Area                  string
}

func DefaultOptions() Options {
	return Options{Size: 1, Speed: 1, Opacity: .8, Area: "5:30"}
}

func (o Options) Validate() error {
	if !o.Danmaku && !o.AnnounceJoin {
		return nil
	}
	if runtime.GOOS != "windows" {
		return errors.New("desktop danmaku and join announcements require Windows")
	}
	if !o.Danmaku {
		return nil
	}
	if !inRange(o.Size, .5, 3) || !inRange(o.Speed, .25, 4) || !inRange(o.Opacity, 0, 1) {
		return errors.New("danmaku requires size 0.5–3, speed 0.25–4 and opacity 0–1")
	}
	_, _, err := parseArea(o.Area)
	return err
}

func inRange(value, low, high float64) bool {
	return !math.IsNaN(value) && low <= value && value <= high
}

func parseArea(area string) (int, int, error) {
	top, bottom, separated := strings.Cut(area, ":")
	lo, topErr := strconv.Atoi(top)
	hi, bottomErr := strconv.Atoi(bottom)
	if !separated || topErr != nil || bottomErr != nil || lo < 0 || hi > 100 || lo >= hi {
		return 0, 0, errors.New("danmaku area requires TOP:BOTTOM with 0 <= TOP < BOTTOM <= 100")
	}
	return lo, hi, nil
}

type Effects struct {
	cancel         context.CancelFunc
	workers        sync.WaitGroup
	chat, arrivals chan signal.RoomEffect
}

func Start(ctx context.Context, options Options, logger *slog.Logger) *Effects {
	effects := &Effects{}
	if !options.Danmaku && !options.AnnounceJoin {
		return effects
	}
	ctx, effects.cancel = context.WithCancel(ctx)
	start := func(queue chan signal.RoomEffect, run func() error) chan signal.RoomEffect {
		effects.workers.Go(func() {
			if err := run(); err != nil {
				logger.Warn("Piik desktop room effect unavailable", "error", err)
			}
		})
		return queue
	}
	if options.Danmaku {
		queue := make(chan signal.RoomEffect, 16)
		effects.chat = start(queue, func() error { return runOverlay(ctx, options, queue) })
	}
	if options.AnnounceJoin {
		queue := make(chan signal.RoomEffect, 8)
		effects.arrivals = start(queue, func() error { return runSpeech(ctx, queue) })
	}
	return effects
}

func (e *Effects) Handler() func(signal.RoomEffect) {
	if e.cancel == nil {
		return nil
	}
	return func(event signal.RoomEffect) {
		queue := e.arrivals
		if event.Kind == signal.ViewerChat {
			queue = e.chat
		}
		select {
		case queue <- event:
		default:
		}
	}
}

func (e *Effects) Close() {
	if e.cancel != nil {
		e.cancel()
		e.workers.Wait()
	}
}

func expired(event signal.RoomEffect) bool {
	select {
	case <-event.Done:
		return true
	default:
		return false
	}
}
