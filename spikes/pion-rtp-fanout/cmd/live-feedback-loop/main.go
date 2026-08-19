package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	fanoutoracle "github.com/TNTcraftHIM/Screener/spikes/pion-rtp-fanout"
)

func main() {
	browser := flag.String("browser", "", "path to Chrome, Chromium, or Edge (or set SCREENER_BROWSER_BIN)")
	timeout := flag.Duration("timeout", 55*time.Second, "overall live feedback-loop gate timeout")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	result, err := fanoutoracle.RunLiveFeedbackLoopBrowserGate(
		ctx,
		fanoutoracle.LiveBridgeOptions{BrowserPath: *browser},
	)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err = encoder.Encode(result); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
