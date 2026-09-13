// Command piik-app is the self-contained Piik App: it opens a
// configured Piik Site, or runs the Local room authority in-process
// (--local / --link) together with the loopback capability service and the
// native media edge. Flags select the mode; app owns every mode's
// lifecycle.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/TNTcraftHIM/Piik/internal/app"
)

func main() {
	code := run(os.Args[1:])
	if code != 0 {
		pauseOnError()
	}
	os.Exit(code)
}

func run(args []string) int {
	var options app.Options
	flags := flag.NewFlagSet("piik-app", flag.ContinueOnError)
	flags.Func("site", "save and open a Piik Site origin", func(value string) error {
		options.Site = value
		options.SiteSet = true
		return nil
	})
	flags.BoolVar(&options.Local, "local", false, "use the self-contained Local room authority")
	flags.BoolVar(&options.Link, "link", false, "create one public Viewer invitation link")
	flags.BoolVar(&options.Debug, "debug", false, "save opt-in App diagnostics to rotated files")
	flags.StringVar(&options.LogDir, "log-dir", "", "diagnostic directory (overrides PIIK_LOG_DIR)")
	flags.StringVar(&options.CaptureProcess, "capture-process", "", "path to the platform native capture process")
	flags.StringVar(&options.TunnelProcess, "tunnel-process", "", "path to the packaged public tunnel process")
	flags.StringVar(&options.ConfigPath, "config", "", "path to the App configuration file")
	flags.StringVar(&options.LANAddress, "lan-address", "", "LAN IPv4 address used in Local invitations")
	flags.IntVar(&options.Port, "port", app.DefaultLocalPort, "Local Piik server port")
	if err := flags.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return 0
		}
		return 2
	}
	options.DisableBrowser = os.Getenv("PIIK_CLIENT_GATE_NO_BROWSER") == "true"

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if options.DisableBrowser {
		go func() {
			var input [1]byte
			if count, _ := os.Stdin.Read(input[:]); count > 0 {
				stop()
			}
		}()
	}
	if err := app.Run(ctx, options); err != nil {
		if options.DisableBrowser {
			fmt.Fprintln(os.Stderr, err)
		}
		return 1
	}
	return 0
}
