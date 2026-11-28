# Remote Control

This standard owns the 3.0 grant, target and release contract for remote input
to a shared App window or screen. The [reader guide](../guide/remote-control.md)
owns usage, shortcuts and gamepad driver setup;
[interaction research](../research/room-interactions.md#remote-co-play) owns
backend rationale and measurements. Published 2.x follows its
[room access standard](https://github.com/TNTcraftHIM/Piik/blob/main/docs/standards/rooms-access.md#remote-control).

## Authorization

Remote input belongs to one active App-owned window or screen share. The sharer
explicitly enables it for that source using Ask each time, Room Viewers or a
separate control password. Viewer identity and requests reuse authenticated room
membership; grants and encrypted input stay bound to the current route and source.
Changing the source, stopping sharing, authorization loss or route retirement
releases the corresponding grants and held input. Reconnection requires a new grant.
Pausing the share releases held input and clears grants and pending requests.
Resuming accepts fresh requests under the same authorization mode.
Preparing a source replacement preserves the current source's authorization;
failed preparation or cancellation does not retire a still-active source.

## Simultaneous Control

Remote control defaults to one controller. The sharer can enable **Allow
simultaneous control** for the current source so that approved Viewers share
input through the same authorization choice. Changing this setting retires
current requests and grants without changing the authorization mode or
password; replacing the source resets it off.

One grant authorizes one Viewer to use keyboard/mouse and an optional supported
gamepad. Switching or combining input devices requires no additional approval,
and simultaneous control counts approved Viewers, not device types. Held keys
and mouse buttons belong to each grant; releasing one participant cannot release
another's still-held inputs. All approved keyboard/mouse grants contribute to the
same pointer, with no per-player mouse assignment or join-order priority.
Committed text insertion is available with one approved Viewer and pauses while
two or more grants coexist; physical key input remains available. Input belongs
to one process-wide source owner, not to several simultaneous shares.

## Release And Failure

Viewers apply valid control-state transitions even with unfamiliar platform,
reason or additional status descriptions. An unavailable update retires local
input and request intent. State, mode and request/grant identifiers keep their
validation.

An individual input execution failure drops that operation and preserves the
grant. Failed key and button releases remain owned cleanup: only releases are
retried, never presses, movement or text. Missing current target geometry
suspends input until observation recovers; confirmed loss of the target's
identity retires its grants. Losing shared-window focus releases held input and
neutralizes gamepads while keeping grants suspended.

Disconnecting a gamepad neutralizes and removes only its device; ending remote
control releases every input owned by that Viewer. The sharer's stop shortcut
ends all remote input.

Optional input drivers and third-party input SDKs stay external on every
platform: Piik does not download, install or bundle them. Each approved Viewer
owns their virtual gamepad under the same grant. Driver connection and device
creation determine availability, and slot limits belong to the platform backend.
Keyboard and mouse input continue when the optional backend is unavailable.
