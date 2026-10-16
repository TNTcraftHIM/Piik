package launcher

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestSiteApprovalIsLocalExplicitAndDoesNotStartARoom(t *testing.T) {
	current := ""
	debugCalls := 0
	server, err := Start(t.Context(), appAssets(), Options{
		ChangeSite:  func(site string) (string, error) { current = site; return current, nil },
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
			request, _ := http.NewRequest("POST", origin+"/api/client-launcher/"+path, strings.NewReader(`{"site":"https://other.example","expectedSite":""}`))
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
	if current != "" || debugCalls != 0 {
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
		site, expected, want string
		status               int
	}{
		{"https://Share.Example:443/", "", "https://share.example", 200},
		{"https://other.example", "", "https://share.example", 409},
		{"", "https://share.example", "", 200},
	} {
		body := fmt.Sprintf(`{"site":%q,"expectedSite":%q}`, test.site, test.expected)
		response, err := localPost(origin+"/api/client-launcher/site", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		var result struct{ Site string }
		err = json.NewDecoder(response.Body).Decode(&result)
		response.Body.Close()
		if err != nil || response.StatusCode != test.status || result.Site != test.want || current != test.want {
			t.Fatalf("approval result: status %d, %+v, saved %q, %v", response.StatusCode, result, current, err)
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
			server, err := Start(t.Context(), appAssets(), Options{Site: "https://old.example", ChangeSite: func(site string) (string, error) {
				if applied {
					return site, errors.New("retirement still pending")
				}
				return "https://old.example", errors.New("save failed")
			}})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = server.Close() })
			origin := strings.TrimSuffix(server.URL(), "/client")
			response, err := localPost(origin+"/api/client-launcher/site", "application/json", strings.NewReader(`{"site":"https://new.example","expectedSite":"https://old.example"}`))
			if err != nil {
				t.Fatal(err)
			}
			var failure struct{ Site, Detail string }
			err = json.NewDecoder(response.Body).Decode(&failure)
			response.Body.Close()
			want := "https://old.example"
			if applied {
				want = "https://new.example"
			}
			if err != nil || response.StatusCode != 503 || failure.Site != want || failure.Detail == "" {
				t.Fatal("error hid actual permission")
			}
			response, err = http.Get(origin + "/api/client-launcher")
			if err != nil {
				t.Fatal(err)
			}
			var state struct{ Site string }
			err = json.NewDecoder(response.Body).Decode(&state)
			response.Body.Close()
			if err != nil || state.Site != want {
				t.Fatal("launcher disagrees with persisted permission")
			}
		})
	}
}
