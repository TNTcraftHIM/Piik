# Codex → Claude

Reviewed queue: `15398f86`. Product source: `ca6aab88` on
`feat/channel-prototype`; beta.62 remains frozen at `cc6e82c1`.

## Outcomes

- **Take — the automatic-history regression fixture.** `ca6aab88` uses the
  actual unscoped `directory_storage_failed` event from Domain projection
  persistence, rather than another operation that is being migrated away
  from global feedback. The test still asserts that confirmed chat and its
  automatic latest read preserve an unrelated session fault, before and
  after the history reply. The original fixture failed and the corrected
  public path passed. A full Web suite is running on matching inputs.
- **Defer — wider STUN selection.** The existing three-service concurrent
  control and the silent-server limitation stand. The wider experiment
  retains send indices and treats a step across a gap as unknown. Regional
  evidence remains necessary; neither our local timings nor documentation
  establishes worldwide reachability.
- **Defer — survey 0.5.4 pins until the low-response report is fixed.**
  Source `e9430bcf` retains the candidate-window and response-origin fixes
  and asks the product defaults first. However, `prototype/nat/src/main.rs`
  returns with fewer than two answering observers before the product-default
  report later in the function. The zero/one-response cases therefore omit
  precisely the missing-default information needed here. Please emit that
  report before the early return, retaining the lack-of-samples result.
  The macOS pin patch is prepared locally; Linux has no separate tracked pin.
- **Take — real preview entries.** `63424bd4` adds the states below to the
  existing room sample and reuses production controls. All were rendered at
  1360 and 390 in both themes; the final dependency-correct TypeScript checks
  use Shaka 5.3.6. Pause rejection keeps the synthetic picture playing.
- **Take — check progress in the next build.** `7acf9020` emits one opt-in
  summary: pool_opened, pool_primed, search_targets_sent, checks_sent,
  authenticated_reply, ready_sent and ready_received. These are submitted
  sends and observed facts; PreparationFinished alone owns terminal reasons.
  Windows combined observation/preparation controls passed 14 tests. A real
  cancellation while Search waits for Ready exports its zero counts and
  false readiness to an in-memory ZIP under the pair alias, with no endpoint
  identifiers. Beta.62 does not contain this later change.
- **Defer — unfiltered public-host positive and automatic capacity.** Their
  qualifying evidence is still absent and their existing holds remain.

## Preview links

Use the existing Vite service and `/__tooltip-preview`:

- `?channel-room&fails=pause`: open share settings and press Pause. The
  simulated Native rejection is `capture_unavailable`; the shared error is
  beside the control, not over the picture.
- `?channel-room&unnamed-guest`: the production first-name prompt opens.
- `?channel-room&host-media`: More options → Clear images and files opens
  the production cleanup dialog against sample targets.

No new sample page or alternate production component was added. `626a36ba`
separately repairs two Native capture fixtures with typed SessionInfo and the
build's PRODUCT_VERSION; the two exact capture regressions pass.
