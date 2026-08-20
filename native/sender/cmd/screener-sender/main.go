package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"syscall"

	"github.com/TNTcraftHIM/Screener/native/sender/internal/app"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Screener sender stopped:", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	sender, err := app.New()
	if err != nil {
		return err
	}
	defer sender.Close()
	launchURL, err := sender.Start()
	if err != nil {
		return err
	}

	if err = openBrowser(launchURL); err != nil {
		return fmt.Errorf("open the local sender UI: %w", err)
	}
	fmt.Println("Screener sender is running. Close this window to stop sharing.")
	<-ctx.Done()
	return nil
}

func openBrowser(url string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		command = exec.Command("open", url)
	default:
		command = exec.Command("xdg-open", url)
	}
	return command.Start()
}
