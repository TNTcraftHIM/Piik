package launcher

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
)

func TestSiteApprovalIsLocalExplicitAndDoesNotStartARoom(t *testing.T) {
	current := []string{}
	debugCalls := 0
	server, err := Start(t.Context(), appAssets(), Options{
		ChangeSite: func(site string, allowed bool) ([]string, error) {
			current = editSites(current, site, allowed)
			return current, nil
		},
		EnableDebug: func() error { debugCalls++; return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	origin := strings.TrimSuffix(server.URL(), "/client")
	for _, path := range []string{"site", "startup-site", "launch", "debug"} {
		for _, test := range []struct{ origin, contentType string }{
			{"", "application/json"}, {"null", "application/json"}, {"https://other.example", "application/json"},
			{origin, "text/plain"}, {origin, "application/x-www-form-urlencoded"},
		} {
			request, _ := http.NewRequest("POST", origin+"/api/client-launcher/"+path, strings.NewReader(`{"site":"https://other.example","allowed":true}`))
			request.Header.Set("Origin", test.origin)
			request.Header.Set("Content-Type", test.contentType)
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != 404 {
				t.Fatalf("mutation admitted nonlocal or form request: %s %+v", path, test)
			}
		}
	}
	if len(current) != 0 || debugCalls != 0 {
		t.Fatal("unapproved request had side effects")
	}
	for range 2 {
		response, err := localPost(origin+"/api/client-launcher/debug", "application/json", strings.NewReader(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatal("standby diagnostics could not start")
		}
	}
	if debugCalls != 1 {
		t.Fatalf("diagnostic owner started %d times", debugCalls)
	}
	for _, test := range []struct {
		site    string
		allowed bool
		want    []string
	}{
		{"https://Share.Example:443/", true, []string{"https://share.example"}},
		{"https://other.example", true, []string{"https://share.example", "https://other.example"}},
		{"https://other.example", true, []string{"https://share.example", "https://other.example"}},
		{"https://share.example", false, []string{"https://other.example"}},
	} {
		body := fmt.Sprintf(`{"site":%q,"allowed":%t}`, test.site, test.allowed)
		response, err := localPost(origin+"/api/client-launcher/site", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		var result struct{ Sites []string }
		err = json.NewDecoder(response.Body).Decode(&result)
		response.Body.Close()
		if err != nil || response.StatusCode != 200 || !slices.Equal(result.Sites, test.want) || !slices.Equal(current, test.want) {
			t.Fatalf("approval result: %d %+v %v", response.StatusCode, result, err)
		}
	}
	select {
	case <-server.Selection():
		t.Fatal("site approval created Local room authority")
	default:
	}
	response, err := http.Get(server.URL())
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.Header.Get("X-Frame-Options") != "DENY" || response.Header.Get("Content-Security-Policy") != "frame-ancestors 'none'" {
		t.Fatal("approval page can be framed")
	}
}

func TestSiteApprovalFailureReflectsTheActualPermission(t *testing.T) {
	for _, applied := range []bool{false, true} {
		t.Run(fmt.Sprint(applied), func(t *testing.T) {
			server, err := Start(t.Context(), appAssets(), Options{Sites: []string{"https://old.example"}, ChangeSite: func(site string, allowed bool) ([]string, error) {
				if applied {
					return []string{}, errors.New("retirement still pending")
				}
				return []string{"https://old.example"}, errors.New("save failed")
			}})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = server.Close() })
			origin := strings.TrimSuffix(server.URL(), "/client")
			response, err := localPost(origin+"/api/client-launcher/site", "application/json", strings.NewReader(`{"site":"https://old.example","allowed":false}`))
			if err != nil {
				t.Fatal(err)
			}
			var failure struct {
				Sites  []string
				Detail string
			}
			err = json.NewDecoder(response.Body).Decode(&failure)
			response.Body.Close()
			want := "https://old.example"
			if applied {
				want = ""
			}
			if err != nil || response.StatusCode != 503 || strings.Join(failure.Sites, ",") != want || failure.Detail == "" {
				t.Fatal("error hid actual permission")
			}
			response, err = http.Get(origin + "/api/client-launcher")
			if err != nil {
				t.Fatal(err)
			}
			var state struct{ Sites []string }
			err = json.NewDecoder(response.Body).Decode(&state)
			response.Body.Close()
			if err != nil || strings.Join(state.Sites, ",") != want {
				t.Fatal("launcher disagrees with persisted permission")
			}
		})
	}
}

func editSites(sites []string, site string, allowed bool) []string {
	sites = slices.Clone(sites)
	if allowed {
		if !slices.Contains(sites, site) {
			sites = append(sites, site)
		}
	} else {
		sites = slices.DeleteFunc(sites, func(value string) bool { return value == site })
	}
	return sites
}
