# ADR-0019: The Life Of A Message

- Status: proposed
- Date: 2026-11-25

## Context

In 2.x a message was temporary. In 3.0 a room keeps its history, so how a
message is sent, changed, removed and found has to be decided, with the fewest
rules that are still correct.

The present model already carries most of it. A message is one row at the
room's writer, which sets its sequence, identity, author and time. Readers
fetch pages from the writer and keep no message bodies between sessions.
Sending and deleting exist. Editing and searching do not. Nothing stored is
signed, so a change to a row breaks no signature.

## Decision

1. **A message is one row at the room's writer.** The writer, not the sender,
   decides its sequence, author and time. This is the present rule.
2. **Edit.** Only the author edits, and only the text and its mentions. The
   writer replaces them and records when. No earlier version is kept, and
   there is no time limit. The interface marks the message as edited, because
   others may have read the original. How a reply's quote follows an edit is
   decided with the feature: a reply stores a short copy of the quoted text
   today, and refreshing every quote in one transaction has no bound.
3. **Delete.** As today: the author or someone who manages the room removes
   the row, an opaque marker stops the same send from being accepted again,
   and its files stop being delivered. Copies that people already received
   cannot be recalled. Whether a reply keeps a marker for a deleted target is
   decided with its interface.
4. **Announcing a change.** A changed message is announced to the readers
   present, and a reader who was away sees the current row when it fetches
   that page. Nothing else synchronises. The rule that merges a change of text
   with a change of reactions is set when editing is built; a later change of
   reactions must never hide an earlier change of text.
5. **Search runs on the reader**, over the pages it reads. A reader holds
   only the pages it has fetched, so a search walks back through the history
   with the read that already exists, matches each page as it arrives, shows
   how far back it has looked and stops when the person stops it. It is a
   literal match of the query within the text, with its treatment of case and
   of equivalent characters stated; it does not claim to understand the words
   of any language. The writer gains no operation, the wire and the stores no
   field, and nothing about search is fixed by a release.
6. **Edit is a capability** a writer announces, under the compatibility rule
   of [ADR-0017](./0017-contracts-fixed-before-release.md), so it can ship
   after the first release. Its stored fields and events are set with the
   feature.

Settled before the stored format is first published: a supported backup must
not drop a row's data without notice. Room backups and room copies reject history rows with
unrecognized fields before installing the archive.

## Not Built

- Earlier versions of an edited message. One row is the simple mechanism, and
  saying "edited" is the honest part.
- A time limit on editing or deleting. It adds a rule and a clock and corrects
  no defect.
- Editing someone else's text, by anyone.
- A copy of the history or a search index kept on a reader between visits.
  The writer is the one authority, and saved and live stay separate.
- A search operation at the writer. A long history is searched in time
  proportional to its length; an operation at the writer is the remedy if a
  real room shows that to be too slow, and it can be added as a capability
  then.
- Search across rooms at the channel, which keeps only basic metadata.
- Deletion as a request that a holder may ignore. With one writer a deletion
  is a commit.

## Consequences

- The interface gains an edit action on one's own messages, an edited mark,
  and a search field in the room.
- A search far back reads the pages between, fifty messages at a time, from
  the device that hosts the room.

## References

- [Matrix client-server API](https://spec.matrix.org/latest/client-server-api/):
  an edit is a replacement event and earlier versions remain; a redaction
  hides content; search runs on the server.
- [XEP-0308, Last Message Correction](https://xmpp.org/extensions/xep-0308.html)
  and [XEP-0424, Message Retraction](https://xmpp.org/extensions/xep-0424.html):
  a correction replaces the shown text, and a retraction is a request.
- [Discord message resource](https://docs.discord.com/developers/resources/message):
  a message carries the time of its last edit and no earlier versions.
