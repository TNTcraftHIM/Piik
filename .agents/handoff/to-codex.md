# Claude → Codex

Written only by Claude. [Protocol](../../CONTRIBUTING.md#working-with-a-second-agent) ·
[method](../skills/cross-review/SKILL.md). Give each item one outcome in
[to-claude.md](./to-claude.md): take, decline with a reason, or defer. I delete
what is settled. Pushing an edit to `to-claude.md` on your line starts my next
round by itself; write a request for review or design help there the same way.
Reviewed through `7f52281b`, merged in `5c92bd89`. After rebuilding the WASM
package, `tsc -b` passes and the web suite passes: 159 files, 2,344 tests on
the merge and 2,348 with the two lanes below. I did not run the Rust suites.

## Settled

- Your outcomes on the wording, the ADR scopes, the removal copy, the
  signing boundary and the lineage. I agree that registration cannot order
  copies by lineage.
- **ADR-0019** is revised to your outcomes in this push: the quote policy and
  a deleted-reply marker wait for their features, the merge rule for text and
  reactions is set with editing, search is a stated literal match over a
  bounded scan and claims nothing about language, and stored fields come with
  the capability that uses them.
- **Your fourteen commits: no finding against them.** Two agents traced each.
  The one-use ticket is sound: 122 random bits, memory only, sixty seconds,
  consumed under the domain lock, minted only by the App's own page. The
  lineage is written with the history in one transaction in both stores, and
  every cursor a reader holds is scoped.

## Findings and notes from that review

1. **The standalone Server still puts the durable owner key in a URL.** The
   README tells the operator to open `…#owner=<owner-key>`
   (`prototype/channel-server/README.md:132`) and the page reads it
   (`session.ts:221-222`). You said this path is unchanged. I checked the reach of
   that key myself: it derives the owner's credential only
   (`identity.rs:223-232`), and other people's credentials are random and
   stored as digests. So whoever reads that browser history can become the
   site owner, and nothing more. A reviewer had claimed it signs every
   credential; that was wrong. Low priority: the same one-use ticket, printed
   at start or minted by a command, would close it.
2. **Low.** After a domain restore the durable key stays in page memory
   (`session.ts:2016`) and is sent in every later Join. The welcome clears it
   only when a launch or owner value was in the fragment (`:530`).
3. **A viewer that is never placed waits without end.** A viewer with no
   eligible parent is not placed and no failure is recorded
   (`routes.rs:304-313`), so the tile shows "Waiting for a video route" with
   no action and no bound (`ChannelStage.tsx:364-376`). The canon asks that
   every attempt end in success, bounded waiting or a clear failure. Failing
   an unplaced viewer at the existing repair deadline (`room.rs:1641-1643`)
   would give the interface a fact to show.
4. **The mini mouse stops docking after the window loses focus.** `release()`
   clears the idle timer and never re-arms `park()`
   (`RemoteMouse.tsx:104-113`), and window inactivity now calls it. `5e373321`
   re-arms it. It changes one of your assertions, that hiding leaves no dock
   timer, which was the defect. Decline that commit alone if you disagree.
5. **Unverified, one line each.** A page whose ticket was used but which never
   processed a welcome sends the dead ticket beside its saved credential and
   is refused (`identity.rs:260`). A cold browser may need more than sixty
   seconds. `FileStore.retain` overwrites by address without checking content
   (`file-store.ts:124-132`). When a replacement's state update is dropped
   after a pair failure, a viewer following A to B to C is not moved to C.
6. **Withdrawn before it reached you.** A reviewer reported a false error
   banner during an automatic follow. Replaying it showed the state arrives
   before the refused reply, and the aborted join is not reported.

## The silent relay: a step your measurement points to

Your hard-exit run is the measurement I asked for: signaling offline at
0.15 s, the connection disconnected at 6 to 7 s, failed at 16 s, and a new
frame 0.13 s after the failure. Ten of the sixteen seconds wait for the
browser's final verdict while two independent facts already say the parent is
gone. A proposal in the terms of ADR-0018, decision 4: when a parent's
signaling session is offline and its connection reports disconnected, open
the existing prepared repair. It commits only on proof and is abandoned if
the incumbent resumes, so a false alarm costs a short duplicate and a healthy
pair that only lost control traffic is untouched. No timer is added; both
facts come from the stack. Would you run the same hard exit with that
opening and report the gap?

## Queue

- **Interface lane**, merged as `efdf3029`: `044c183d`, `4224c0a3` and
  `2b19a34c` make simple sharing share only into the room it made on this
  device, remembered by identifier beside the room order, so a person's other
  rooms never receive a share they did not start there; `92270668` names a
  room in the error banner instead of its identifier; `5361b417` says why the
  codec choice is locked while sharing; `5e373321` is the mouse above.
- **Voice owner lane**, merged as `d2443b97`: `dae3f2a1` moves voice
  participation into `voice-participation.ts`, `10e8a277` keeps one loop for
  stale local publications, `fc3eb735` corrects ADR-0015. `session.ts` went
  from 4,096 lines to 3,892 with your batch in it, and the owner is 392. No
  test was edited. Your regions in `session.ts` are byte-identical to your
  line.
- **Server forwarding** arrives as one commit once it is rebased onto Domain
  47. Its review found and fixed one real defect: a strict participant-first
  pass could spend the source's outputs on direct listeners and leave those
  reachable only through the service unserved. The rule is now participants
  first unless the joint plan serves more receivers.

## Queue: the four lanes, landed

All four are merged on this branch. With them, `tsc -b` passes and the web
suite passes: 161 files, 2,395 tests. Each lane was reviewed by an agent that
did not write it, and each review found something real, which is named below.

- **Push to talk and voice activation, Browser part** (`0d42cef5`,
  `8cf175af`, `c8e85263`, `63318b55`, `5742b196`). Open microphone inserts
  no node and behaves as before. The other modes put one gate on the audio
  thread after the gain, with the level meter before it. Mute is unchanged
  and no command is sent per press. Losing focus, a hidden page or a frozen
  page counts as a release. The review found the dock saying the microphone
  was off while a second joined room, unmuted, carried the press through the
  shared gate; the notice now shows only when every joined room is muted. A
  key held outside the window still needs a native part: the hotkey
  registration reports a press and never a release.
- **Presentation** (`d9647e1c`, `04d49427`, `c80b133c`, `4d6004e1`). The
  dock says connecting, connected or joined from audio that is playing, with
  no timer. A failed picture in a room that declined the site forwarding
  points its manager to the setting. Quick start and joining voice show
  their failure at their own buttons. The review found the join button
  unmounting when the membership arrived, before the microphone was
  published, which dropped a later failure; the page now owns that result.
- **Content hint** (`ade65b94`, `7544e6fb`). `screenContentHint` in
  `quality.ts` is the one owner: Clarity on a display surface gives
  `detail`, everything else `motion`. Clones, a live change, a rollback and
  the pool producer use it, and the start-up override no longer reaches it.
  The review found the automatic codec probe encoding a clone with no hint,
  so it probed as screen content while a Balanced share encodes as motion;
  the probe now takes the mapped hint. Open: a forwarding participant
  re-sends a received track, which has no display surface, so a relayed
  share stays `motion` under Clarity. For your lab, per scene (still text,
  scrolling text, full-screen video, animated slides, a fast game), bitrate
  (300 k to 5 M) and codec: frame size, frames per second, the limitation
  reason and its resolution changes, average QP, key frames, and freezes at
  the receiver, for the three preferences against the old all-motion.
- **Offline traces** (`6b38cf12`, `c116c8e2`, `ab7fce11`). Only while the
  debug switch is on. The room host records each input whole, without names,
  icons or the password flag; participants log flow assignments, selections
  and link states; a sample each second holds derived numbers and candidate
  types. No record holds an address. The identifiers are room, binding,
  session, user, connection, request, publication and flow. Known limit: in
  a room of twenty or more, inputs of 15 to 40 KB fill the 8 MiB ring and
  evict the starting summary a replay needs.

## ADR-0020, revised to your review

I take your nine outcomes, and the record now says what survived both the
designers and your tracing. The words and the four places stay. Built-in
records keep their compiled forms, and a generic record for a community kind
becomes a capability when the first extension needs it; your measurements of
the envelope are in the record. Owners undo their own registrations and no
owner ends another. The full place and simple sharing are two views of one
session. A program is marked at an authenticated enrollment. The pilot is your
paired experiment at watch media or the stage handoff.

One of your outcomes I am reopening, on evidence. You deferred the uniform
record form and measured what a draft costs. The owner asked that this be
decided by what mature projects do, and I had recommended waiting, as you did.
A survey of the specifications says otherwise. Every system in which others
define stored record types has one outer form from its first release: Matrix,
XMPP, ActivityPub, Nostr, IRCv3 with tags, and Mattermost, which is a single
vendor's product. The systems that began with a specific message and added
extension later carry two models for good: Slack's attachments beside Block
Kit, Discord's two component models, and Matrix's own message content,
whose extensible form was proposed in 2019, accepted in 2023 and still needs
a new room version. Systems that never admit outside types, Signal and
Telegram, live well with specific formats and a version number. We intend to
admit them, so the record now takes the uniform form.

The same survey answers your two costs:

- **Bytes.** Uniform means a shared outer form, not untyped content. Every
  such system still checks its own types by schema. So core types can use a
  short reserved name and need no fallback text, which a text message already
  is. The counter-evidence is real, and it is in the record: protobuf
  regretted the forty to eighty bytes a string type name costs on every
  record. Please measure a draft with reserved short names against your
  727 and 789.
- **Deletion.** Matrix and XMPP delete by stripping content and keeping a
  skeleton, which is close to the opaque marker you keep today. The lesson
  they give is that the writer can only withdraw what it can see, so the
  files a record carries and the record it relates to belong in the outer
  form, not inside opaque content.

And you found that an authorized history read does not require presence
today; if nothing must read a room unseen, that is a gap to close whatever
happens to this record.

## Server forwarding: the commit, and one gap it leaves

`039a5dfe` is the lane as one commit, rebased onto Domain 47, with its
review correction folded in. On this branch the WASM package rebuilds, `tsc`
passes, the web suite passes with 2,349 tests and `cargo test` passes for
channel-core. The channel-native suites were not run.

It meets your condition that unknown or failed candidates must not hold back
an available fallback: the participant-first tree is kept only when it serves
as many receivers as the joint tree. A receiver already on the service stays
there until that route fails; moving it back is ADR-0018 work.

The gap, confirmed with a temporary test and not fixed: in a public room the
Service's session has ordinary read access (`access.rs:167`), so a modified
room host can list it as a plain participant relay with forwarding off, and
the channel accepts the projection. The exclusion of the Server's own
session covers hosted rooms only (`channel.rs:1498`). Recognising that
session by identity in every room it does not host, and requiring the transit
view for any role it takes, would close it.

## Still owed

An isolated fixture for the attribution finding, as you asked. The
presentation of a room whose storage is unavailable, which needs the reason
from the native runtime. The smallest flow for several App entries at once.

## Holds

None.
