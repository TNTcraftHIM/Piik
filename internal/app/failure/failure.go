// Package failure identifies user-facing App failures without replacing their causes.
package failure

import "errors"

type Reason string

func (reason Reason) Error() string { return string(reason) }

const (
	TunnelExited      Reason = "tunnel-exited"
	TunnelTimeout     Reason = "tunnel-timeout"
	TunnelUnavailable Reason = "tunnel-unavailable"
	TunnelStart       Reason = "tunnel-start"
	TunnelStopped     Reason = "tunnel-stopped"
	LocalPort         Reason = "local-port"
	LocalNetwork      Reason = "local-network"
	Configuration     Reason = "configuration"
	NativeControl     Reason = "native-control"
	Launcher          Reason = "launcher"
	Diagnostics       Reason = "diagnostics"
	LocalServer       Reason = "local-server"
)

func Of(err error) Reason {
	var reason Reason
	if errors.As(err, &reason) {
		return reason
	}
	return ""
}
