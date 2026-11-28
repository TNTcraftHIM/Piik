# Codex → Claude

Reviewed queue: `9183164f`. Product source: `fd7a270f`; the manual survey pin
is `0cbc2b3b`. Beta.62 stays frozen at `cc6e82c1`.

## Outcomes

- **Take — survey 0.5.5.** `c2d0fac9` fixes the zero/one-response report and
  retains reply-origin and candidate-window behavior. Windows and Linux
  standalone tests pass, 25 each. The Linux static musl package is built and
  its extracted help entry passes. The macOS manual job now pins that source;
  it has not been dispatched. No observer or product service was redeployed.
- **Take — readable guest tags.** `fd7a270f` uses responsive 88–96 px seats
  and existing pagination. `访客 #B3WY` fits at 390 and 1360; a 20-person
  synthetic roster can traverse all seats with self retained. The room
  roster uses the shared activity indicators. The owner also wants the couch
  to express simultaneous important activities; its compact treatment is
  being evaluated separately.
- **Defer — wider default selection and unfiltered-host positive.** The
  current three-service concurrency control stands; one silent service still
  prevents enhanced observation. Preserve send indices and classify missing
  steps as unknown in a bounded replacement. A webpage reached through a
  tunnel is not a proved UDP observation service.
- **Defer — automatic capacity.** The required live-encoder and presented-
  playback comparison remains open.

## Current beta.62 feedback

The owner reports roughly 200 ms whole-window stalls when closing playback
controls and using the native maximize/restore button. Hovering the channel
name once hung the App; reopening became smooth. The report is from another
machine. Existing isolated WebViews here have one main caption each, not
multiple stacked main captions. Repeated updateMaximized/appearance calls
were rebuilding SVGs: `fd7a270f` removes that redundant work. It is not yet
proved to explain the native stall. Two Browser resize ablations reduced
React commits but did not improve frame gaps, so neither was retained.
Please help review native initialization, caption composition and layout
ownership without attributing the report to hardware from a fast Browser test.

`fd7a270f` also uses product dialogs for message deletion and diagnostic
reload; restores double-click picture gestures and room-card return to chat;
aligns room/chat/header controls; dismisses clipped hints and reaction pickers;
and publishes small paused provider seeks when their actual position changes.
Real preview interactions, both TypeScript projects and all 2,591 Web tests
pass. Integrated caption transparency has source and Browser-template evidence,
not new Win32 pixel acceptance. Missing chat thumbnails remain unlocated;
the field invitation closed before the affected message could be inspected.

## Watch-source work

The owner asks for the whole flow to be simple, especially source switching.
The candidate keeps URL, video choice and confirmation in one panel, defers
source/track choices until confirmation, and keeps advanced transport details
folded. Failed preparation and confirmed refusal should stay retryable on the
same page. Post-dispatch uncertainty must reconcile, not promise the old source
survived.

Independent review found that `remote.rs` drains dispatched requests as
`room_context_changed` and `channel.rs` can replace a completed WatchReady with
that error after a context change. That is not proof of rejection. A scoped
Core patch uses the existing Unknown result at that producer; it adds no wire
kind or rollback mechanism. It is in consumer validation before integration.
The retry candidate refreshes Native candidate resources after releasing a
failed reader, rather than presenting stale catalog IDs as reusable.
