// Command piik-client is the self-contained Piik Client: it opens a
// configured Piik Site, or runs the Local room authority in-process
// (--local / --link) together with the loopback capability service and the
// native media edge. Flags select the mode; clientapp owns every mode's
// lifecycle.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/TNTcraftHIM/Piik/internal/client/clientapp"
)

func main() {
	var options clientapp.Options
	flag.Func("site", "save and open a Piik Site origin", func(value string) error {
		options.Site = value
		options.SiteSet = true
		return nil
	})
	flag.BoolVar(&options.Local, "local", false, "use the self-contained Local room authority")
	flag.BoolVar(&options.Link, "link", false, "create one public Viewer invitation link")
	flag.BoolVar(&options.Debug, "debug", false, "save opt-in Client diagnostics to rotated files")
	flag.StringVar(&options.LogDir, "log-dir", "", "diagnostic directory (overrides PIIK_LOG_DIR)")
	flag.StringVar(&options.CaptureProcess, "capture-process", "", "path to the platform native capture process")
	flag.StringVar(&options.TunnelProcess, "tunnel-process", "", "path to the packaged public tunnel process")
	flag.StringVar(&options.ConfigPath, "config", "", "path to the Client configuration file")
	flag.StringVar(&options.LANAddress, "lan-address", "", "LAN IPv4 address used in Local invitations")
	flag.IntVar(&options.Port, "port", clientapp.DefaultLocalPort, "Local Piik server port")
	flag.Parse()
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
	if err := clientapp.Run(ctx, options); err != nil {
		if options.DisableBrowser {
			fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(1)
	}
}
