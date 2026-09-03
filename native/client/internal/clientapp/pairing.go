package clientapp

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/TNTcraftHIM/Screener/native/client/internal/browser"
	"github.com/TNTcraftHIM/Screener/native/client/internal/directpair"
)

const maxPairingInputBytes = 132 * 1024

func runPairHost(ctx context.Context, options Options) error {
	reader := bufio.NewReaderSize(input(options), maxPairingInputBytes)
	writer := output(options)
	sessions := make(map[*directpair.Host]struct{})
	released := make(chan *directpair.Host, maxDirectPairs)
	defer func() {
		for session := range sessions {
			_ = session.Close()
		}
	}()
	for {
		drainReleased(sessions, released)
		if len(sessions) >= maxDirectPairs {
			fmt.Fprintln(writer, "The room has reached its Viewer limit.")
			select {
			case session := <-released:
				delete(sessions, session)
			case <-ctx.Done():
				return nil
			}
			continue
		}
		fmt.Fprintln(writer, "Paste a Viewer invitation:")
		invitation, err := readLine(reader)
		if err != nil {
			return err
		}
		host, offer, err := directpair.NewHost(ctx, directpair.HostOptions{
			Invitation:    invitation,
			TargetAddress: fmt.Sprintf("127.0.0.1:%d", options.Port),
			STUNURLs:      []string{pairSTUNURL(options)},
		})
		if err != nil {
			fmt.Fprintln(writer, "The invitation could not be paired; try again.")
			continue
		}
		fmt.Fprintln(writer, "Send this offer to the Viewer:")
		fmt.Fprintln(writer, offer)
		fmt.Fprintln(writer, "Paste the Viewer answer:")
		answer, readErr := readLine(reader)
		if readErr != nil {
			_ = host.Close()
			return readErr
		}
		if err = host.AcceptAnswer(answer); err == nil {
			err = host.WaitReady(ctx)
		}
		if err != nil {
			_ = host.Close()
			fmt.Fprintln(writer, "The Viewer could not connect; try again.")
			continue
		}
		sessions[host] = struct{}{}
		go func() {
			<-host.Done()
			released <- host
		}()
		fmt.Fprintln(writer, "Viewer connected. Another Viewer may be paired now.")
	}
}

func drainReleased(
	sessions map[*directpair.Host]struct{},
	released <-chan *directpair.Host,
) {
	for {
		select {
		case session := <-released:
			delete(sessions, session)
		default:
			return
		}
	}
}

func runPairViewer(ctx context.Context, options Options) error {
	reader := bufio.NewReaderSize(input(options), maxPairingInputBytes)
	writer := output(options)
	fmt.Fprintln(writer, "Paste the Host offer:")
	offer, err := readLine(reader)
	if err != nil {
		return err
	}
	viewer, answer, err := directpair.NewViewer(ctx, offer, directpair.ViewerOptions{})
	if err != nil {
		return errors.New("the Host offer could not be opened")
	}
	defer viewer.Close()
	fmt.Fprintln(writer, "Send this answer to the Host:")
	fmt.Fprintln(writer, answer)
	target, err := viewer.WaitInvitation(ctx)
	if err != nil {
		return err
	}
	if !options.DisableBrowser {
		if err = browser.Open(target); err != nil {
			return errors.New("Screener Client could not open the paired room")
		}
	}
	fmt.Fprintln(writer, "Paired room connected.")
	select {
	case err = <-viewer.Failed():
		return err
	case <-ctx.Done():
		return nil
	}
}

func pairSTUNURL(options Options) string {
	if value := strings.TrimSpace(options.PairSTUN); value != "" {
		return value
	}
	return DefaultPairSTUNURL
}

func input(options Options) io.Reader {
	if options.Input != nil {
		return options.Input
	}
	return os.Stdin
}

func output(options Options) io.Writer {
	if options.Output != nil {
		return options.Output
	}
	return os.Stdout
}

func readLine(reader *bufio.Reader) (string, error) {
	bytes, err := reader.ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) {
		return "", errors.New("pairing input is too large")
	}
	value := strings.TrimSpace(string(bytes))
	if err != nil && value == "" {
		return "", err
	}
	if value == "" {
		return "", errors.New("pairing input is empty")
	}
	return value, nil
}
