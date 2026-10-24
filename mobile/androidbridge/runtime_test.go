package androidbridge

import (
	"context"
	appconfig "github.com/TNTcraftHIM/Piik/internal/app/config"
	"github.com/TNTcraftHIM/Piik/internal/app/loopback"
	"path/filepath"
	"slices"
	"testing"
)

func TestSiteApprovalPersistsExactOriginAndRevocation(t *testing.T) {
	control, err := loopback.Start(context.Background(), loopback.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()
	path := filepath.Join(t.TempDir(), "client.json")
	cfg, err := appconfig.LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	platform := &testPlatform{}
	r := &Runtime{capture: &capture{platform: platform}, control: control, url: "http://127.0.0.1:49152/#piik-client=1", configPath: path, config: cfg}
	var notified []bool
	platform.siteChanged = func() { notified = append(notified, r.TrustedURL("https://piik.example")) }
	navigation, err := r.SiteURL("PIIK.example:443")
	if err != nil || navigation != "https://piik.example/#piik-client=1" || r.TrustedURL(navigation) {
		t.Fatalf("navigation must not authorize a site: %q %v", navigation, err)
	}
	invitation, err := r.SiteURL("https://PIIK.example:443/r/1234?lang=en#v=fixture-invite&piik-client=0")
	if err != nil || invitation != "https://piik.example/r/1234?lang=en#piik-client=1&v=fixture-invite" || r.TrustedURL(invitation) {
		t.Fatalf("invitation navigation lost state or authorized a site: %q %v", invitation, err)
	}
	for _, invalid := range []string{"", "http://piik.example", "https://user@piik.example"} {
		if _, err := r.SiteURL(invalid); err == nil {
			t.Fatalf("invalid hosted navigation accepted: %q", invalid)
		}
	}
	site, err := r.approveSite("PIIK.example:443")
	if err != nil || site != "https://piik.example" {
		t.Fatalf("approval: %q %v", site, err)
	}
	if !r.TrustedURL(site+"/room#local") || r.TrustedURL("https://other.example") || r.TrustedURL("http://piik.example") || !r.TrustedURL(r.url) {
		t.Fatal("incorrect exact origin trust")
	}
	persisted, err := appconfig.LoadOrCreate(path)
	if err != nil || len(persisted.ApprovedSites()) != 1 {
		t.Fatalf("approval not persisted: %v", err)
	}
	if _, err = r.approveSite("https://piik.example/room"); err == nil {
		t.Fatal("navigation URL granted as an origin")
	}
	if _, err = r.approveSite("http://piik.example"); err == nil {
		t.Fatal("insecure hosted site approved")
	}
	if err = r.revokeSite(site); err != nil {
		t.Fatal(err)
	}
	if r.TrustedURL(site) || !r.TrustedURL(r.url) {
		t.Fatal("revocation changed wrong authority")
	}
	if !slices.Equal(notified, []bool{true, false}) {
		t.Fatalf("platform observed stale site authority: %v", notified)
	}
	persisted, err = appconfig.LoadOrCreate(path)
	if err != nil || len(persisted.ApprovedSites()) != 0 {
		t.Fatal("revocation not persisted")
	}
}
