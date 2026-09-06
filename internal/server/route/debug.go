package route

import (
	"log/slog"
	"os"
	"strconv"
	"strings"

	"github.com/TNTcraftHIM/Screener/internal/server/protocol"
)

// debugEnabled is the port of `debuglog("screener-route")`: read once,
// enabled by SCREENER_DEBUG=route (comma-separated like NODE_DEBUG).
var debugEnabled = routeDebugEnabled(os.Getenv("SCREENER_DEBUG"))

func routeDebugEnabled(value string) bool {
	for _, section := range strings.Split(value, ",") {
		if strings.TrimSpace(section) == "route" {
			return true
		}
	}
	return false
}

// debugCandidate is the `{route, transition}` item of "operation-started".
type debugCandidate struct {
	Route      string
	Transition TransitionKind
}

// debug ports 4911: one sanitised event with the room's debug ID, the
// current revision and fact version, then the caller's key/value details.
// Never pass raw peer IDs, session IDs or connection IDs; use debugPeer and
// debugTuple. It is a no-op without the env flag or a DebugRoomID; the
// level is Info because the env flag is the gate, as NODE_DEBUG was.
func (c *Controller) debug(event string, details ...any) {
	if !debugEnabled || c.debugRoomID == "" {
		return
	}
	args := make([]any, 0, 8+len(details))
	args = append(args,
		"event", event,
		"roomId", c.debugRoomID,
		"revision", c.revision,
		"factVersion", c.factVersion)
	args = append(args, details...)
	slog.Info("screener-route", args...)
}

// debugPeer ports 4895: "host", "viewer-<joinOrder>" or "viewer-unknown".
func (c *Controller) debugPeer(peerID string) string {
	current, _ := c.participants.Get(peerID)
	if peerID == c.hostPeerID || (current != nil && current.role == protocol.RoleHost) {
		return "host"
	}
	if current == nil {
		return "viewer-unknown"
	}
	return "viewer-" + strconv.FormatInt(current.joinOrder, 10)
}

// debugTuple ports 4903: "p2p:<label>[:regenerate]" or "sfu:<publication>".
func (c *Controller) debugTuple(tuple CandidateTuple) string {
	if tuple.Kind == UpstreamPeer {
		label := "p2p:" + c.debugPeer(tuple.ParentPeerID)
		if tuple.Regenerate {
			label += ":regenerate"
		}
		return label
	}
	return "sfu:" + string(tuple.Publication)
}
