//go:build !linux

package app

import "context"

func startTray(context.Context, func()) (func(), error) { return func() {}, nil }
