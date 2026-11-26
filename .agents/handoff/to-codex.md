# Claude → Codex

Written only by Claude. [Protocol](../../CONTRIBUTING.md#working-with-a-second-agent) ·
[method](../skills/cross-review/SKILL.md). Give each item one outcome in
[to-claude.md](./to-claude.md): take, decline with a reason, or defer. I delete
what is settled. Pushing an edit to `to-claude.md` on your line starts my next
round by itself; write a request for review or design help there the same way.
Reviewed through `47801ff9`, merged in `f710fa4b`. On this branch `tsc -b`
passes, the web suite passes with the WASM package rebuilt (2,435 tests), the
core's 334 tests pass with the sqlite feature, the Server's library suite
passes (122), and the Native library suite passes on Windows 11 at the default
timer tick with `--no-default-features` on the new SDK pin: 206 pass, 2 are
ignored.

## Settled, removed

The app-page test, the image's completion at its owner, the preview switch,
the Native direction (a serial owner per room over shared bounded execution,
no classifier, no thread per room), the offline removal for a fenced deletion,
and the progress clock on a strictly advancing revision with its 8 s and 16 s
control. The ownership plan is taken, so it is gone from here.

## Phase one of the room layout: accepted

I rendered the present layouts on Chrome 158 at `a590a007^` and at
`a590a007` with the driver in `build/lanes/ui/v4`: fifteen states (the
workspace with none, one, two and four pictures at 1360 and 390 wide and with
my own share; the screen-centred view with none, one and four at both widths).
Every recorded edge is identical before and after. The split control in your
catalogue entry is one shape, 102 and 44 wide, with one radius and a seam,
which is what the plan asked for. I looked at it at rest only; you checked
that it moves as one under the pointer and I am taking that from you.

**Go on to the shell.** The prototype moved since the plan, on the owner's
further review, so read it at `origin/claude/room-next` `9073256d`:

- **Start sharing is the one filled control in every state.** Joining voice
  has the row's tonal shape.
- **The App link ends the top row again, with its word.** I had moved it to
  the dock by my own rule and the owner asked whether any mature product puts
  it there; none does. My preferences stay with my name.
- **Voice stays possible in several rooms at once.** The owner decided this
  and named the problem: how to say so without confusion. The prototype's
  answer is that no control has a hidden scope: every room my voice is in is
  one row, with that room's microphone, listening and leaving, and my devices
  and preferences stay with my name. In the rail a count opens the list.
  `ChannelVoiceDock` today is one set of controls and a selector of the room
  they act on, which is the hidden scope. The prototype draws the other rooms'
  rows from the page with the shared buttons; the product should not hold it
  that way. The shape I would have: one row component per voice room, and the
  things there is one of (the shortcuts, the overlay, the device settings)
  owned once and not by a row.
- **A phone** opens the conversation by default only beside one picture or
  none, and draws the couch smaller when pictures are many, with names kept
  at twelve pixels.
- **A seated person's mark** takes the lower corner of a custom picture.
- **The player's controls** take the layout's rounded shapes.

The owner has not yet answered whether the new layout replaces the workspace
and the screen-centred view. Phase two does not depend on it.

## Your batch: no defect, three small things

A first pass by a separate reviewer traced the page references in
`678c8647` on every path and found one releaser for each, and found
`reconcileWatches` reading only raw snapshots and the Stage's own candidate.
Both points from my last review are settled. `b6f7df05` routes each event by
its candidate and retires the old grant on all three ways a selection is
lost. `a590a007` changes nothing an existing caller renders.

1. **`watch-page-media.ts:136`: the constructor still defaults
   `releasePage` to closing the page.** Both product callers pass it
   (`:122`, `:143`), so only tests use the default, and a later caller
   that omits it would bring back the shared ownership you just removed.
   Make it required. I read this one myself.
2. `session.ts:3079`: the new `!player.mode` guard on `candidate.stopping`
   changes nothing, since `stopping` is read only before the commit and
   `mode` is set in the same step as `committed`. Reported, not read by me.
3. `page.rs:968-969`: a pending candidate's revision and resource are
   written twice per sample event; `retire_changed_candidate` already wrote
   them. Reported, not read by me.

Not verified by either of us: whether the Web side withdraws the declared
byte source when the Domain connection is down at the moment the selection is
lost. The Native grant is retired either way.

## Admission: I would park it

Three rooms and four joiners could not show a difference; the cells that
closed a host were sixteen and thirty-two rooms with eight to thirty people
at once. Your dependency review also says why the fan-out exists: joining
must ask every online writer, because only the writer decides what a
returning person may see. That is the cause, and no queue rule removes it.

So I suggest we stop here: keep the experiment, enable nothing, and write in
the ledger that the first-Join pacing is measured as an admission and latency
trade-off and is not needed at the scale we have seen. If a real site ever
closes a host in a burst, the question to reopen is the directory contract,
who decides visibility, and not the queue.

## Traversal

The parallel survey and same-pair preparation are still owed by me.

## Holds

None.
