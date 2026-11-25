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
   writer replaces them in one transaction and records when. No earlier
   version is kept, and there is no time limit. A reply that quotes the
   message has its quote refreshed in the same transaction. The interface
   marks the message as edited, because others may have read the original.
3. **Delete.** As today: the author or someone who manages the room removes
   the row, and an opaque marker stops the same send from being accepted
   again. Its files stop being delivered. A reply to a deleted message keeps
   its place and says that the quoted message was deleted. Copies that people
   already received cannot be recalled.
4. **One revision per message.** It covers the text and the reactions. One
   record announces a changed message to the readers present. A reader who was
   away sees the current row when it fetches that page. Nothing else
   synchronises.
5. **Search runs at the writer**, which owns the history. A query returns the
   matching messages a page at a time, through the records paging already
   uses. The rule is a plain match of the query within the text, written once
   in the core for both stores. It is correct for every language without a
   tokenizer. An index is an optimisation that can be added later and rebuilt
   from the text.
6. **Edit and search are capabilities** a writer announces, under the
   compatibility rule of [ADR-0017](./0017-contracts-fixed-before-release.md),
   so either can ship after the first release.

Settled before the stored format is first published: the time of the last
edit, the meaning of the one revision, the record for a changed message, the
marker a reply keeps when its target is deleted, and that a backup's rows
either define an unknown field or refuse it. Today an unknown field is
dropped on import without notice.

## Not Built

- Earlier versions of an edited message. One row is the simple mechanism, and
  saying "edited" is the honest part.
- A time limit on editing or deleting. It adds a rule and a clock and corrects
  no defect.
- Editing someone else's text, by anyone.
- A copy of the history or a search index on a reader. The writer is the one
  authority, and saved and live stay separate.
- Search across rooms at the channel, which keeps only basic metadata.
- Deletion as a request that a holder may ignore. With one writer a deletion
  is a commit.

## Consequences

- The room store gains one field and one meaning for its revision, and the
  wire gains two commands and one record.
- The interface gains an edit action on one's own messages, an edited mark,
  and a search field in the room.
- A room with a long history is searched by reading it. If that proves slow,
  an index is added without changing these rules.

## References

- [Matrix client-server API](https://spec.matrix.org/latest/client-server-api/):
  an edit is a replacement event and earlier versions remain; a redaction
  hides content; search runs on the server.
- [XEP-0308, Last Message Correction](https://xmpp.org/extensions/xep-0308.html)
  and [XEP-0424, Message Retraction](https://xmpp.org/extensions/xep-0424.html):
  a correction replaces the shown text, and a retraction is a request.
- [Discord message resource](https://docs.discord.com/developers/resources/message):
  a message carries the time of its last edit and no earlier versions.
