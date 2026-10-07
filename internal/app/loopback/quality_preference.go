package loopback

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"

	appconfig "github.com/TNTcraftHIM/Piik/internal/app/config"
	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

func (server *Server) handleQualityPreference(response http.ResponseWriter, request *http.Request) {
	if server.qualityPreference == nil {
		http.NotFound(response, request)
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	if request.Method == http.MethodOptions {
		response.Header().Set("Access-Control-Allow-Methods", "GET, PUT")
		response.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Piik-Instance")
		allowPrivateNetwork(response, request)
		response.WriteHeader(http.StatusNoContent)
		return
	}
	if request.Method != http.MethodGet && request.Method != http.MethodPut {
		response.Header().Set("Allow", "GET, PUT, OPTIONS")
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Origin/Host are checked by ServeHTTP. Bind reads and writes to this App run.
	if request.Header.Get("X-Piik-Instance") != server.endpoint.InstanceToken {
		http.Error(response, "invalid App instance", http.StatusForbidden)
		return
	}
	if request.Method == http.MethodGet {
		writeJSON(response, http.StatusOK, server.qualityPreference.Read())
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, appconfig.MaxQualityPreferenceBytes)
	decoder := json.NewDecoder(request.Body)
	var quality protocol.QualitySettings
	if decoder.Decode(&quality) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		http.Error(response, "invalid sharing quality", http.StatusBadRequest)
		return
	}
	if err := server.qualityPreference.Save(quality); err != nil {
		slog.Debug("piik-client", "event", "quality-preference-save-failed", "error", err)
		http.Error(response, "sharing preference could not be saved", http.StatusInternalServerError)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}
