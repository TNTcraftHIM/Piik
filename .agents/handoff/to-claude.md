# Codex → Claude

Reviewed queue: `9183164f`. Product source: `4de6d9cb`; the manual survey pin
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
  roster uses the shared activity indicators. `4de6d9cb` keeps the primary
  couch emblem and adds the shared plus glyph for another non-voice category.
  File sending and receiving count once; voice retains the headset. Actual
  ChannelCouch controls at 390/1200 cover the figure, avatar and full description.
- **Defer — wider default selection and unfiltered-host positive.** The
  current three-service concurrency control stands; one silent service still
  prevents enhanced observation. Preserve send indices and classify missing
  steps as unknown in a bounded replacement. A webpage reached through a
  tunnel is not a proved UDP observation service.
- **Defer — automatic capacity.** The required live-encoder and presented-
  playback comparison remains open.

## Native interaction and chat images

The owner reports roughly 200 ms whole-window stalls when closing playback
controls and using the native maximize/restore button. Hovering the channel
name once hung the App; reopening became smooth. The report is from another
machine. Existing isolated WebViews here have one main caption each, not
multiple stacked main captions. Repeated updateMaximized/appearance calls
were rebuilding SVGs: `fd7a270f` removes that redundant work. It is not yet
proved to explain the native stall. Two Browser resize ablations reduced
React commits but did not improve frame gaps, so neither was retained.
The frontend caption measurement coalesces within a frame. Repeated menu and
tooltip controls return their listeners to baseline and emit no caption IPC.
Native maximize can reposition the caption twice, but eliminating that extra
position has no measured stall benefit, so that separate candidate was not
retained. Please continue reviewing native composition and resize ownership
without attributing the report to hardware from a fast Browser test.

Integrated caption transparency still needs matching Windows pixel acceptance.
The owner confirmed the missing thumbnails are chat images. Actual Browser
image submission and a later member's history read preserve the thumbnail.
The Native/SQLite path stores it with the message; it rejects an oversized
message rather than silently stripping the image. Image decoding or generation
failure can leave a file description without a thumbnail, but the affected
message is unavailable. No speculative thumbnail repair was added.

## Watch-source changes ready for review

The owner asks for the whole flow to be simple, especially source switching.
`96ac42db` keeps URL, video choice and confirmation in one panel, defers
source/track choices until confirmation, and keeps advanced transport details
folded. Failed preparation and confirmed refusal stay retryable on the same
page. Refreshed Native catalogs invalidate old draft IDs. The final action is
Start watching together or Switch video. The two guides follow those controls.

`ebb37095` reports dispatched work as Unknown when its binding retires or the
requester's context changes, including after the writer returned WatchReady.
Only a confirmed rejection keeps the retry choice. No new wire kind or rollback
was added. Native, Node SDK and CLI readers also treat Unknown as unconfirmed.
All 348 SQLite Core tests, both TypeScript projects and 2,592 Web tests pass
with the rebuilt WASM. Actual React plus ChannelSession controls verify retry
after refreshed IDs and cancellation; Native reader controls verify keeping A
while cancelling B. Matching-window and remote playback acceptance remain open.

## Prepared socket handoff

`b064f509` fixes a separate reachable failure: mutual checks can complete
before their five-second cutoff, then the driver or RTC queue adopts the result
after that cutoff. Prepared::commit was discarding this proved socket. The
deadline now applies when mutual completion produces Prepared. Existing pair
and RTC generation checks own adoption. Sixteen Windows preparation tests pass,
including authenticated completion, delayed adoption, late completion refusal
and wrong-pair release. The two new handoff controls also pass on Linux. This
is not a diagnosis of the field visitor's failures.

## Observation gaps

The wider-STUN-set proposal needs more than preserving response indices. A
request that receives no answer may still allocate a NAT mapping; a retransmit
may reuse it or be the first packet that reaches the NAT. Three consecutive
reported ports therefore cannot fix the cursor after a fourth unanswered
request. A bounded offline replay confirms the ambiguity. The production
defaults and classifier remain unchanged pending the survey's regional evidence.
