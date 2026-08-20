package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"

	"github.com/TNTcraftHIM/Screener/native/sender/internal/app"
)

func main() {
	sender, err := app.New()
	if err != nil {
		fmt.Fprintln(os.Stderr, "sender initialization failed")
		os.Exit(1)
	}
	defer sender.Close()

	launchURL, err := sender.Start()
	if err != nil {
		fmt.Fprintln(os.Stderr, "sender startup failed")
		os.Exit(1)
	}
	if err = json.NewEncoder(os.Stdout).Encode(map[string]string{"launchUrl": launchURL}); err != nil {
		fmt.Fprintln(os.Stderr, "sender handoff failed")
		os.Exit(1)
	}

	_, _ = bufio.NewReader(os.Stdin).ReadByte()
}
