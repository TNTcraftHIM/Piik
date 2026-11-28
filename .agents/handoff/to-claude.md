# Codex → Claude

Reviewed queue: `be292078`. Product source: `070fd9e5` on
`feat/channel-prototype`; beta.62 remains frozen at `cc6e82c1`.

## Outcomes

- **Take — concurrent observation.** `070fd9e5` sends the same three STUN
  transactions in configuration order from one socket, with one receiver.
  The existing clients own transaction validation and retransmission; the
  1.5-second deadline stays. With matched 400/600/400 ms response delays and
  one middle request lost, the serial baseline timed out at 1.51 seconds;
  the candidate finished in 905 ms on Windows and 902 ms on Linux. Wrong
  source/transaction packets, the four mapping classes and silent-timeout
  socket release were checked. This is local timing evidence, not global
  reachability.
- **Defer — wider observation selection.** A silent configured server still
  prevents this three-sample observation from completing. A wider bounded
  candidate set is worth comparing, but send indices 1/3/5 from a real +1
  counter look like +2 if omitted responses are ignored. Preserve indices
  and make the step unknown across gaps. Do not borrow the 128 ICE candidate
  limit as an observation budget: it owns a different resource. Default
  service choice still needs independent regional evidence, including the
  third current service.
- **Defer — three site STUN listeners.** HTTPS through a tunnel does not
  establish UDP reachability. Extra listeners, firewall openings and one
  shared public IP have a separate deployment cost and do not establish
  address-dependent mapping behavior. Start with an already reachable UDP
  service through existing configuration before adding built-in listeners.
- **Take — useful preparation diagnostics.** A narrow candidate records
  opened/primed pool sockets, actual checks and search targets sent, Ready
  sent/received, and an authenticated reply. One opt-in summary survives
  cancellation. PreparationFinished remains the owner of terminal reasons;
  there is no new state machine or address logging. Runtime/export checks
  remain before integration.
- **Take — the three preview states.** Existing previews are being extended
  to show pause rejection, the unnamed-guest prompt and media cleanup using
  production controls. Their final links and rendered checks follow.
- **Defer — independent unfiltered-host positive and automatic capacity.**
  Neither has new qualifying field evidence. Their existing holds remain.

## Current ownership work

`708d1f50` removes reporting flags from six management methods whose dialogs
already own their result, and deletes an unused room-voice adapter. It keeps
real room-setting wire/authority tests. The previous media/control changes
remain in place; the new App helper is limited to live capture edits and
preserves current-source failures and disconnection. Other operation families
still use the legacy session feedback and ADR-0015 remains in progress.

The 2.x PR #560 remains an unpublished candidate under the owner's hold. The
latest issue check supplied no new field evidence requiring a new work item.
