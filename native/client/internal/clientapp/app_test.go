package clientapp

import (
	"context"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/TNTcraftHIM/Screener/native/client/internal/clientconfig"
)

func TestPackagePathsValidateAnExplicitPackage(t *testing.T) {
	nodePath, appDirectory := packageFixture(t)
	actualNode, actualApp, err := packagePaths(nodePath, appDirectory)
	if err != nil || actualNode != nodePath || actualApp != appDirectory {
		t.Fatalf("packagePaths = %q, %q, %v", actualNode, actualApp, err)
	}
}

func TestPackagePathsRequireTheExactPackagedRevision(t *testing.T) {
	nodePath, appDirectory := packageFixture(t)
	if err := os.WriteFile(filepath.Join(appDirectory, "REVISION"), []byte("different"), 0o600); err != nil {
		t.Fatal(err)
	}
	previous := BuildRevision
	BuildRevision = "expected"
	t.Cleanup(func() { BuildRevision = previous })
	if _, _, err := packagePaths(nodePath, appDirectory); err == nil {
		t.Fatal("mismatched package revision was accepted")
	}
	if err := os.WriteFile(filepath.Join(appDirectory, "REVISION"), []byte("expected\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := packagePaths(nodePath, appDirectory); err != nil {
		t.Fatal(err)
	}
}

func TestLaunchURLCarriesNativeSelectionWithoutChangingOrigin(t *testing.T) {
	value := launchURL("https://share.example/", Options{
		Native:             true,
		NativeWindowTitle:  "My Game",
		NativeAdapterIndex: 2,
		NativeEncoderIndex: 1,
	})
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "share.example" ||
		parsed.RawQuery != "" {
		t.Fatalf("launch URL = %q, %v", value, err)
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil || fragment.Get("screener-native") != "1" ||
		fragment.Get("screener-native-window") != "My Game" ||
		fragment.Get("screener-native-adapter") != "2" ||
		fragment.Get("screener-native-encoder") != "1" {
		t.Fatalf("native launch fragment = %q, %v", parsed.Fragment, err)
	}
}

func TestNativeRuntimeRequiresTheExplicitLaunchMode(t *testing.T) {
	runtime, err := nativeRuntimeForOptions(t.Context(), Options{
		CaptureProcess: "missing-capture-process",
	})
	if err != nil || runtime.available() || runtime.controlFactory(false) != nil {
		t.Fatalf("ordinary Client exposed native runtime: %+v, %v", runtime, err)
	}
	if _, err = nativeRuntimeForOptions(context.Background(), Options{
		Native: true, CaptureProcess: "missing-capture-process",
	}); err == nil {
		t.Fatal("explicit native mode accepted a missing capture process")
	}
}

func TestLaunchURLLeavesOrdinaryClientURLUntouched(t *testing.T) {
	const original = "http://localhost:8787/#client-access=secret"
	if actual := launchURL(original, Options{}); actual != original {
		t.Fatalf("ordinary launch URL = %q", actual)
	}
}

func TestLaunchURLPreservesLocalAccessInsideThePrivateFragment(t *testing.T) {
	value := launchURL("http://localhost:8787/#client-access=secret", Options{
		Native: true, NativeWindowTitle: "My Game",
	})
	parsed, err := url.Parse(value)
	if err != nil || parsed.RawQuery != "" {
		t.Fatalf("local native launch URL = %q, %v", value, err)
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil || fragment.Get("client-access") != "secret" ||
		fragment.Get("screener-native-window") != "My Game" {
		t.Fatalf("local native launch fragment = %q, %v", parsed.Fragment, err)
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

func TestLocalEnvironmentOwnsItsSTUNConfiguration(t *testing.T) {
	t.Setenv("STUN_URLS", "stun:inherited.example:3478")
	environment := localEnvironment(
		8787,
		"192.168.1.2",
		[]string{"192.168.1.2"},
		"abcdefghijklmnopqrstuvwxyzABCDEF",
		[]string{"stun:public.example:3478"},
		"https://small-bright-room.trycloudflare.com",
	)
	stunEntries := []string{}
	publicEntries := []string{}
	for _, entry := range environment {
		if strings.HasPrefix(entry, "STUN_URLS=") {
			stunEntries = append(stunEntries, entry)
		}
		if strings.HasPrefix(entry, "SCREENER_CLIENT_PUBLIC_ORIGIN=") {
			publicEntries = append(publicEntries, entry)
		}
	}
	if len(stunEntries) != 1 || stunEntries[0] != "STUN_URLS=stun:public.example:3478" {
		t.Fatalf("Local STUN environment = %v", stunEntries)
	}
	if len(publicEntries) != 1 ||
		publicEntries[0] != "SCREENER_CLIENT_PUBLIC_ORIGIN=https://small-bright-room.trycloudflare.com" {
		t.Fatalf("Local public environment = %v", publicEntries)
	}
}

func packageFixture(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	nodeName := "node"
	if runtime.GOOS == "windows" {
		nodeName += ".exe"
	}
	nodePath := filepath.Join(root, nodeName)
	appDirectory := filepath.Join(root, "app")
	entry := filepath.Join(appDirectory, "dist", "server", "server", "local-index.js")
	if err := os.MkdirAll(filepath.Dir(entry), 0o700); err != nil {
		t.Fatal(err)
	}
	for path, body := range map[string]string{nodePath: "node", entry: "entry"} {
		if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return nodePath, appDirectory
}
