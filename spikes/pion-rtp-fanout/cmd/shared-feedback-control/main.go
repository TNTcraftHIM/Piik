package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	fanoutoracle "github.com/TNTcraftHIM/Screener/spikes/pion-rtp-fanout"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result, err := fanoutoracle.RunFeedbackControlOracle(ctx)
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
