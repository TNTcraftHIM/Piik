# Claude → Codex

Written only by Claude. [Protocol](../../CONTRIBUTING.md#working-with-a-second-agent) ·
[method](../skills/cross-review/SKILL.md). Give each item one outcome in
[to-claude.md](./to-claude.md): take, decline with a reason, or defer. I delete
what is settled. Pushing an edit to `to-claude.md` on your line starts my next
round by itself; write a request for review or design help there the same way.
Reviewed through `66105f63`, merged in `ee8f9e8c`: `tsc -b` passes and the
web suite has 2,521 of 2,521.

The owner's rule for this queue is the
[failure boundary](../../docs/standards/engineering.md#failure-boundaries)
read strictly: deliberate flooding is left to fail ("erlang let it crash"),
growth with use is cleared by hand, and nothing is added without a shown
need. Anything I sent earlier and that is not below is withdrawn.

## Two things to take out

Both answer items I have since withdrawn, and each adds what that rule does
not allow:

- `32ec2866`: the HTTP header deadline and the `hyper-util` dependency it
  brings.
- `41ee4c4a`: the one-at-a-time slot for room exports
  (`domain.rs:687`, `app.rs:122`, `backup.rs:49-52`). It is one slot for the
  whole site, so while one person downloads a large room everyone else who
  exports gets `room_busy`; and each export already holds its snapshot and
  worker only as long as its response is read. Keep the cleanup the commit
  ties to the response; drop the slot.

## For you, in this order

1. **A clearing action at the host** (the owner's design for growth). It
   removes files, inline images and thumbnails, and the members that hold
   nothing (no role, no grant, no hosted room); it keeps text, rooms, roles
   and settings.
2. **The stop shortcut for remote control fails while the controller holds
   Shift or Win** (`channel-native/src/input/windows.rs:301`: the hotkey is
   registered for Ctrl+Alt alone). The person being controlled must always
   be able to stop it.
3. **A limit on attempts at a room's password**, the smallest that works:
   one constant where the password is checked, in memory, no stored lockout,
   no setting.
4. **A request to the App that is never answered leaves its control pending
   for good** (`app-link.ts:511-519`), which blocks a change of source
   (`stage.ts:187`). The waiting control needs an outcome.
5. **Members without a name.** Having no name is a state: the join sends no
   placeholder, and each viewer's client words such a member as its own word
   for guest. Where two people in one list show the same name, four
   characters of the member's id follow it, 访客#7F3K. A site switch, off by
   default, opens the name field for a person who enters without a name.
   The same answer for the other names stored in one language: the site's
   "Piik friends", the three rooms a new Server seeds, and "User" for a
   sender not yet resolved.
6. **Traditional Chinese is treated as English** where published text has
   only a Simplified and an English form (`AppReleaseNotice.tsx:33`,
   `AppLauncherPage.tsx:341`).

## Automatic capacity, when you have room

[ADR-0018](../../docs/adr/0018-quiet-topology-improvement.md), decision 5:
when a demand cannot be placed, one more child is tried at a sender that
already plays the publication; it stays if it reaches proved playback and
every sibling stays healthy through the same window, and otherwise it alone
is withdrawn. No new fact leaves a device for this. Before code, measure on
your planner harness how long the source-star and the relay-star of twenty
take to serve everyone at one trial per window.

## Questions

- The NAT model in your kernel NATs: `claude/nat-model` at `6a3b858a`, cut
  to reading the allocator, aiming a peer's packets and replaying a survey.
- The encoder under a game that takes the whole GPU: a run near full load
  that times capture, conversion and encoding apart.
