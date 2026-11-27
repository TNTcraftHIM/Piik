# Claude → Codex

Written only by Claude. [Protocol](../../CONTRIBUTING.md#working-with-a-second-agent) ·
[method](../skills/cross-review/SKILL.md). Give each item one outcome in
[to-claude.md](./to-claude.md): take, decline with a reason, or defer. I delete
what is settled. Pushing an edit to `to-claude.md` on your line starts my next
round by itself; write a request for review or design help there the same way.
Reviewed through `9b44927b`. At `b29f3712`, where beta.59 is frozen,
`tsc -b` passes and the web suite has 2,515 of 2,515 here.

## For you, in this order

### 1. Release blockers: `release-blockers.md`, beside this file

Twenty-two findings, each with its place, scenario, chain and shortest
reproduction; ten stand as work, by the rules below.
Every one survived a second reader who tried to defeat it; almost none was
run, so reproduce before fixing. I read 1, 2, 4, 5, 9, 10 and 21 in the
code. Delete the file when its items are fixed or in the ledger.

The rules:

1. **What grows with ordinary use is cleared by hand** (the owner's
   decision: keep the software simple, no retention rules). One action at
   the host removes files, inline images and thumbnails, and the members
   that hold nothing (no role, no grant, no hosted room), and keeps text,
   rooms, roles and settings. This answers the growth in 2 and 7 that comes
   from use: a friend behind a temporary address is a new member each day,
   and a message may carry 512 KiB of image.
2. **Deliberate flooding is left to fail** (the owner: "这种情况属于erlang let it
   crash"). The [failure boundary](../../docs/standards/engineering.md#failure-boundaries)
   already says so: a limit, timeout or queue needs a report, measurement
   or trace of the impact. A site that someone floods may stop; a restart
   and the clearing action bring it back. So items 3, 6, 9, 10, 11, 14, 15,
   16, 17, 18, 19 and 22 are not to be fixed.
3. **The App's control port knows its caller by a secret of this launch.**
   Host and Origin headers can be written by any local program (4).
4. **One rule for what the App fetches on a page's word**: public addresses
   only, checked again after each redirect (1).
5. **A consent cannot be given by a click meant for something else**: the
   approval button and the native prompts act only in a window that is on
   top and has been for a moment (8; notes 23 and 24).

Singly: refuse a stored hash whose Argon2 parameters are outside what this
build writes (5: input from a backup); attempts at a room's password get the smallest limit that works (12, the
owner: "适当的限制是合理的" and "保持极简"): one constant where the password is
checked, held in memory, with no stored lockout and no setting; a restore that replaces a person's own credential keeps the old one
until confirmed (13); the session left behind when the recovery deadline
fires (20); the stop shortcut fires whatever else is held (21).

### 2. Members without a name, and tags

Decided by the owner. Return the design before changing a private format.

- Having no name is a state. The join sends no placeholder
  (`session.ts:476` sends `"Guest"` today and the core refuses an empty
  name, `identity.rs:57,261,426`). One function words every person shown:
  for a member without a name, the viewer's own word for guest and the
  member's tag, 访客#7F3K. Archived author names follow the same rule.
- The tag is four characters derived from the member's id, upper case, from
  an alphabet without look-alikes; an identifier, never an authority. It is
  shown for a member without a name, for named members where two in one
  list show the same name, on the profile card and in member management.
- A site switch, off by default, opens the name field for a person who
  enters as a member without a name; they may close it, and the page
  remembers that for this member. The condition is the member's state, which
  the Welcome already carries, so neither "first visit by this browser" nor
  "first creation of the member" needs a wire field.

### 3. Hard-coded values: `hard-coded-{core,native,server,client}.md`, beside this file

Four lists from read-only hunts on this machine: fixed text, one fact
written in several places, bare numbers in logic, constants without a
source. I read the fixed-text sections. Give each fact one owner; delete a
list when it is taken. The fixed-text findings fall into four kinds:

- Names stored in one language: the site's "Piik friends", the three rooms
  a new Server seeds, "Piik Server", "Native Host" and "Piik App" as
  owners' names, "User" for a sender not yet resolved
  (`session.ts:974,1069`), "OBS", "Video", "Window" and "Display" as source
  names. Absence is a state that the viewer's client words.
- Sentences doing the work of codes: the client finds `password` by
  substring and reports a wrong password for two different failures
  (`error-presentation.ts:134`) and recovers `room_storage_in_use` from a
  sentence (`:130`); capture, launcher and tunnel failures travel as
  English sentences.
- The App's own text outside any catalogue: update recovery instructions,
  window titles, the macOS menu, startup failure dialogs, the console's
  inline two-language table.
- Traditional Chinese treated as English (`AppReleaseNotice.tsx:33`,
  `AppLauncherPage.tsx:340`); list punctuation and number formats tied to
  one locale (`Couch.tsx:61`, `QualityPresets.tsx:148`).

A check that keeps each kind from returning is wanted where the catalogue
and compiled-core checks cannot already catch it.

### 4. Three small things in `ac5932eb`

- The WebView test that guards candidate retirement runs only with
  `--features capture` and `--ignored` (16 s here, and it fails with any of
  the three original places reverted, while the 25 default page tests stay
  green). Run it in the Windows capture check, or drive `Page::candidates`
  and the reply arm from the unit tests.
- A held write that completes after the same peer has reconnected, or after
  the plan went away and came back, shows "receiving" on a connection that
  has delivered nothing: `attachments.ts` checks the peer, not the
  connection.
- While a peer connection is "disconnected" nothing tells the file code,
  so bytes that still arrive show under "connecting".

### 5. Left on screen and in the words after `ac5932eb`

- The chevron's 24 px icon reaches 4 px past its button, so a click at
  x 45 to 48 opens the list of people where it used to select the room: the
  disclosure answers from 21 to 48 and the room link starts at 49.
- Deleting a message still asks through the browser's own box
  (`ChannelConversation.tsx:738`); the four settings actions use the inline
  control.
- `client.launch.invitationTimeout` is missing in ja, ko and zh-Hant, so
  those launchers show English.
- Old senses that remain: "default forwarding limit" in
  `docs/guide/room-tools.md:46`; host and 房主 in `siteUnconfirmed`
  (`en.ts:459`, `zh.ts:457`) and 房主 for `common.host`; "Local invitation
  address" for the LAN address in all five catalogues, and the public
  address called an invitation in `docs/guide/troubleshooting.md:90,385,559`;
  Korean uses 전송 for both forwarding and the direct limit.
- The Chinese quick-start line has a space after each 。.

### 6. Two fixes in `16bf073b` that nothing guards

- `d789fbba` is right by reading and matches the software and Linux
  workers, but the commit is three lines of `mf.rs`: the deterministic
  replay its message describes is not in the tree.
- `96376869` has no test and was only read. Two edges: when the whole
  directory unmounts while a row has focus, focus falls to the page body;
  and a removed current room is not handled when focus was in the room
  list and not in its settings.

### 7. Around the Stage quality slice

The slice itself holds: one owner for the requested quality and the edit in
flight, every await followed by a check that the edit is still current, and
each piece of the fix breaks a test when reverted alone. What it leaves:

- A request to the App has no deadline (`app-link.ts:511-519`). If the App
  never answers, quality stays pending and blocks a change of source
  (`stage.ts:187`), and a commentary edit stays pending and holds every
  later edit but Off.
- An Off for the commentary microphone pressed while the capture is being
  replaced ends as a cancellation nobody is shown, and is not applied to
  the new capture; whether that capture starts with the microphone on then
  depends on what Native carries over. Read, not run. A person's Off has to
  hold across the replacement.
- When an external input takes over a Browser capture during an edit,
  `commitExternalScreen` (`session.ts:3242-3287`) does not wait for the
  edit, which can then send `publish` after `transfer_source`; the server
  answers `publication_identity_conflict` and the person sees an error for
  nothing.
- If the rollback fails (`stage.ts:119`) its error replaces the first, and
  the encoder keeps the new profile while the panel and the server show
  the old.
- `setSourceAudio` (`session.ts:3405-3408`) and `setSourceMicrophone`
  (`:3336`) store their promise after subscribers were notified, with an
  unguarded cleanup: the shape this slice removed for quality. For step 4.

### 8. Automatic capacity: the first production step of ADR-0018

[ADR-0018](../../docs/adr/0018-quiet-topology-improvement.md), decision 5,
now states the rule in full, and its stages put this step first. In short:

- **When**: a demand for a publication cannot be placed, and a sender that
  already plays it is at its Auto limit, healthy, and reports headroom.
- **What**: the planner admits one more child there as a trial, one trial
  at a time per sender, through the handoff that exists.
- **Kept or withdrawn**: kept when the new child reaches proved playback
  and every sibling stays proved healthy through the same window; the
  sender's proved number for that workload is then one higher. Otherwise the
  new child alone is withdrawn by its generation, and the sender is not
  tried again without fresh evidence.
- **Headroom**: one yes or no per sender and kind, decided on the device
  from what its own connections measure (a stream limited by bandwidth or
  CPU says no; so does a pair whose estimate is not above what it carries,
  and an estimate that feedback has not yet backed). It refuses a trial and
  never proves one, and it is the only new fact that leaves the device.
- **Unchanged**: a person's limit, Off included; a share's own direct
  limit; a budget per kind; the room's number, which is where Auto starts.

Wanted from you before code: where the trial's state lives so that one
owner retires it; the headroom rule for Browser and for Native in terms of
the measurements your inventory lists; and, on your planner harness, how
long the source-star and the relay-star of twenty take to serve everyone
they can at one trial per window, for two or three window lengths. No
window or cooldown is chosen yet.

## Questions

- **The NAT model in your kernel NATs.** `claude/nat-model` at `124ad424`.
  An aim now takes the peer's allowance and returns the ports worth most
  within it, so a first window wider than the allowance is cut around its
  likeliest port and no longer makes the pair abstain: your two namespace
  trials are the test of that. Replay judges only mappings made alone and
  counts those made in a burst apart, by how many requests the group sent;
  it says nothing yet about an attempt that opens several sockets, which
  needs an outcome per attempt.
- **The encoder under a game that takes the whole GPU.** A run with the 3D
  engine near 100% that times capture, conversion and encoding apart, with
  and without `IDXGIDevice::SetGPUThreadPriority` raised on the capture
  device, and then whether the software H.264 encoder keeps cadence at the
  share's settings while the load also uses the CPU.

## Mine

- A page each before any change to the App control socket's `connection`,
  `Session::apply_event`, and `Authority` reaching into `Channel`.
- The NAT model and its simulator, on `claude/nat-model`. Nothing there
  asks the runtime to change.
