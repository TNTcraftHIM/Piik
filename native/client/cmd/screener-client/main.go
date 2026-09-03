package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/TNTcraftHIM/Screener/native/client/internal/clientapp"
)

func main() {
	var options clientapp.Options
	flag.Func("site", "save and open a Screener Site origin", func(value string) error {
		options.Site = value
		options.SiteSet = true
		return nil
	})
	flag.BoolVar(&options.Local, "local", false, "use the self-contained Local room authority")
	flag.BoolVar(&options.PairHost, "pair-host", false, "host a manually paired Internet Viewer")
	flag.BoolVar(&options.PairViewer, "pair-viewer", false, "join a manually paired Internet Host")
	flag.StringVar(&options.PairSTUN, "pair-stun", clientapp.DefaultPairSTUNURL, "Host STUN URL used for manual Client pairing")
	flag.StringVar(&options.NodePath, "node", "", "path to the bundled Node runtime")
	flag.StringVar(&options.AppDirectory, "app", "", "path to the bundled Screener application")
	flag.StringVar(&options.CaptureProcess, "capture-process", "", "path to the Windows native capture process")
	flag.StringVar(&options.ConfigPath, "config", "", "path to the Client configuration file")
	flag.StringVar(&options.LANAddress, "lan-address", "", "LAN IPv4 address used in Local invitations")
	flag.IntVar(&options.Port, "port", clientapp.DefaultLocalPort, "Local Screener server port")
	flag.BoolVar(&options.Native, "native", false, "use the Client's native capture and encoder")
	flag.StringVar(&options.NativeWindowTitle, "native-window-title", "", "capture a window whose title contains this text")
	flag.IntVar(&options.NativeAdapterIndex, "native-adapter-index", -1, "native hardware adapter index")
	flag.IntVar(&options.NativeEncoderIndex, "native-encoder-index", -1, "native hardware encoder index")
	flag.Parse()
	options.DisableBrowser = os.Getenv("SCREENER_CLIENT_GATE_NO_BROWSER") == "true"
	options.Input = os.Stdin
	options.Output = os.Stdout

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if !options.PairHost && !options.PairViewer {
		go func() {
			var input [1]byte
			if count, _ := os.Stdin.Read(input[:]); count > 0 {
				stop()
			}
		}()
	}
	if err := clientapp.Run(ctx, options); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
