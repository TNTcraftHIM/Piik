package clientapp

import (
	"net/url"
	"slices"
	"testing"

	"github.com/TNTcraftHIM/Screener/internal/client/clientconfig"
	serverconfig "github.com/TNTcraftHIM/Screener/internal/server/config"
)

func TestClientLaunchURLMarksThePageWithoutChangingOrigin(t *testing.T) {
	value := clientLaunchURL("https://share.example/")
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "share.example" ||
		parsed.RawQuery != "" {
		t.Fatalf("launch URL = %q, %v", value, err)
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil || fragment.Get("screener-client") != "1" {
		t.Fatalf("Client launch fragment = %q, %v", parsed.Fragment, err)
	}
}

func TestMissingCaptureKeepsViewerControlAvailable(t *testing.T) {
	native := discoverNativeMedia(t.Context(), "missing-capture-process")
	if native.capabilities.Video || native.capabilities.HardwareH264 {
		t.Fatalf("missing native capture = %+v", native)
	}
	control := native.controlFactory()()
	if control == nil {
		t.Fatal("missing capture disabled the native Viewer control")
	}
	_ = control.Close()
}

func TestLaunchURLPreservesLocalAccessInsideThePrivateFragment(t *testing.T) {
	value := clientLaunchURL("http://localhost:8787/#client-access=secret")
	parsed, err := url.Parse(value)
	if err != nil || parsed.RawQuery != "" {
		t.Fatalf("local native launch URL = %q, %v", value, err)
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil || fragment.Get("client-access") != "secret" ||
		fragment.Get("screener-client") != "1" {
		t.Fatalf("local native launch fragment = %q, %v", parsed.Fragment, err)
	}
}

func TestLaunchURLEncodesAndClearsOptionalLocalAccess(t *testing.T) {
	value := clientLaunchURLWithLocalAccess(
		"http://localhost:8787/#retained=yes&client-access=old",
		"a+b&c?d=e",
	)
	parsed, err := url.Parse(value)
	if err != nil {
		t.Fatal(err)
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil || fragment.Get("client-access") != "a+b&c?d=e" ||
		fragment.Get("screener-client") != "1" || fragment.Get("retained") != "yes" {
		t.Fatalf("encoded local launch fragment = %q, %v", parsed.Fragment, err)
	}

	open := clientLaunchURLWithLocalAccess("http://localhost:8787/#client-access=old", "")
	parsed, err = url.Parse(open)
	if err != nil {
		t.Fatal(err)
	}
	fragment, err = url.ParseQuery(parsed.Fragment)
	if err != nil || fragment.Get("client-access") != "" || fragment.Get("screener-client") != "1" {
		t.Fatalf("open local launch fragment = %q, %v", parsed.Fragment, err)
	}
}

func TestLinkModeKeepsOneLocalAuthority(t *testing.T) {
	config := clientconfig.Config{
		Version:             1,
		LocalAccessPassword: "abcdefghijklmnopqrstuvwxyzABCDEF",
		Site:                "https://example.test",
	}
	selected, err := applyMode(config, Options{Link: true})
	if err != nil || selected.Site != config.Site {
		t.Fatalf("link mode = %+v, %v", selected, err)
	}
	if err = validateMode(Options{Link: true, SiteSet: true}); err == nil {
		t.Fatal("link mode accepted a separate Site")
	}
	if err = validateMode(Options{Link: true, Local: true}); err == nil {
		t.Fatal("link mode accepted a second Local selector")
	}
}

// The Local room authority owns its ICE configuration: a STUN_URLS meant for
// the Client's own Pion edge must not reach it, and only --link is public.
func TestLocalServerOwnsItsSTUNConfiguration(t *testing.T) {
	t.Setenv("STUN_URLS", "stun:inherited.example:3478")
	for _, testCase := range []struct {
		name                  string
		link                  bool
		stunURLs              []string
		natPredictionSTUNURLs []string
	}{
		{name: "local"},
		{
			name: "link", link: true,
			stunURLs: []string{publicSTUNURL},
			natPredictionSTUNURLs: []string{
				publicNATPredictionSTUNURLA, publicNATPredictionSTUNURLB,
			},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			stunURLs, natPredictionSTUNURLs := localSTUNURLs(testCase.link)
			if !slices.Equal(stunURLs, testCase.stunURLs) ||
				!slices.Equal(natPredictionSTUNURLs, testCase.natPredictionSTUNURLs) {
				t.Fatalf("Local STUN selection = %v, %v", stunURLs, natPredictionSTUNURLs)
			}
			config, err := serverconfig.Local(serverconfig.LocalOptions{
				Port:                  8787,
				PublicAddress:         "192.168.1.2",
				AllowedAddresses:      []string{"192.168.1.2"},
				SiteAccessPassword:    "abcdefghijklmnopqrstuvwxyzABCDEF",
				STUNURLs:              stunURLs,
				NATPredictionSTUNURLs: natPredictionSTUNURLs,
			})
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(config.STUNURLs, testCase.stunURLs) ||
				config.NATPredictionEnabled != testCase.link {
				t.Fatalf("Local server config = %v, NAT prediction %t",
					config.STUNURLs, config.NATPredictionEnabled)
			}
		})
	}
}
