# Chat, voice and remote control

This guide covers the 3.0 internal test. For the published version, use the [maintenance guide](https://github.com/TNTcraftHIM/Piik/blob/main/docs/guide/room-tools.md).

English · [简体中文](./room-tools.zh-CN.md) · [Documentation](./README.md)

A site contains rooms. Select a room in the sidebar to read its conversation.
Once admitted to that room, you can chat, join voice, share a picture or watch
someone else's share. Anyone can create a room and manage their own rooms.
The site's maintainer manages its name, image and backup.

The people panel groups site users into **This room**, **Online** and **Offline**.
Under each room, the left list shows people participating in voice, sharing,
watching or file transfers, including those actively forwarding. Headset, sharing
and watching icons show their activities. Folding the list keeps those activities running.

Use **Edit profile** beside your name to change your nickname or picture.
The same picture appears on your little person's body in chat, voice and the couch.
Choose **Remove picture** to return to the plain coloured person.

## Choose your interface

**Full workspace** is the default. If you already use another voice app and only
need Piik for screen sharing, choose **More options → Interface → Simple sharing**.
Select **Start sharing**, choose a source, then copy the invitation below the picture.
The picture, playback controls and couch stay central; **Interact** opens the room tool.
**Join voice** stays beside the couch; after joining, its voice controls include
mute, listening and leave. Opening the inline interaction panel leaves the couch in place.
Several people can share at once: select **Watch** on each picture you want,
then choose grid or focus. Stopping one picture keeps the others playing.

Changing interfaces keeps current shares, watches, drafts and joined voice.
Joined voice retains its controls and leave action. Switch back to **Full workspace**
for the room directory and wider administration. **Invitation → Access settings**
opens the existing room settings in either view. The browser remembers your choice.

## Manage a room

Open the room list (**Rooms** on a narrow screen), then select the settings
button beside that room. This leaves your current conversation and activities
in place. The tabs show the tasks available to you:

- **Room:** Change the name, image or access, then **Save**. **Hide from users
  without access** hides a private room from people who have not been admitted.
  Under **Users with access**, **Remove room access** ends that user's access and
  activities in this room; they need a new grant to return.
- **Connection:** Choose how many people this device helps forward to in this room.
- **Records:** Export loaded chat text. Room owners can also export a full backup
  or a copy that someone else can use to create a new room.

Invitations open beside the room title. Copy the link there or use the QR button
below the copy action. Public rooms share a direct link; private invitations
grant access only to their room. Switching to public keeps an existing private
key, but ordinary public access does not grant later private access. Resetting
a private invitation invalidates its old links without revoking admitted users. To replace
its link, expand **Reset room invitation**, then select **Confirm invitation reset**.
Rooms with a password also offer **Password-required link**. New visitors use that password;
people who already have access can enter directly.
The site operator opens settings by selecting the site name above the room list.

### Back up or copy a room

To preserve the original room, use **Records → Export full backup**. To restore
it, choose **Restore full backup**, select the ZIP and confirm the replacement.
The backup contains room settings, complete message history and locally retained files.

To give someone a copy, choose **Export room copy**, optionally including room
information. They select **Create room → Load a room copy**, choose the new name
and access settings, then create it. Messages, reaction counts and available
files remain; their own account manages the new room.

A **site backup** contains site data and the room directory. Each room owner
backs up their own rooms, without centralizing everyone's records at the site operator.

## Chat and reactions

1. Select a room and send a message in its conversation. Use the attachment
   button to add an image or file; you can include text with it.
2. Hover over a message or focus its reaction button with the keyboard to show
   **React to this message**. Touchscreens keep the button visible. Existing
   counts stay below the message; each confirmed click adds one, including
   another click on the same reaction after the brief cooldown.
3. To read back, select **Earlier messages**. **Latest messages** returns to
   the current conversation.

An unread dot beside a room means it has messages beyond your last reading
position. Reading the latest messages to the bottom in a focused conversation
clears it. This browser remembers that position; background voice or watching
does not mark messages as read.

Type `@` and choose a person to mention them. The highlighted name stays linked
to that user even if their nickname changes. Use **Reply to this message** beside
a message to quote it above the composer; cancel the quote without losing your
draft, or turn off **Notify reply recipient** for that reply. Select a sent quote to jump
to its original message, then **Latest messages** to return.

On a desktop, Enter sends and Shift+Enter adds a line. On a touchscreen, Return
adds a line and **Send** sends the message. Ctrl+Enter or Command+Enter also sends.

Confirmed messages and their reaction counts are saved by the room's host. Refreshing
or returning to the room loads its history again when that host is available.
Chat and history use the site connection and do not wait for a P2P link.
The site forwards message text; it does not keep the room's history.
Images use a shared 512 KiB budget per message for immediate display. Small
originals stay unchanged; larger still images get a clear preview up to 2048px.
Select a picture to enlarge it, then **View original** for its full resolution.
**Download original** always retrieves the original file. Preview images remain
in history even when the sender leaves; obtaining a larger original needs a
participant who still holds it.

GIF, animated PNG and animated WebP retain their animation. If an animated
original exceeds its share of the message budget, **View image** loads it over
the existing P2P path. Other files use that same on-demand path, reusing active
connections. Selecting a user's profile picture also opens the image viewer;
Escape or its close button returns to the room.

Selecting a person in the room opens their interaction menu. Expressions and
thrown props are live effects; they are not saved as message reactions.
Beside the viewer count on each picture, reactions use the same controls as
messages. Click an existing reaction to add another, or use **React to this screen**
to choose a different one. Counts last for that share; loading counts does not replay animations.

**More options → Feedback sounds** turns on quiet message and throw sounds for
this browser. Sounds start off. New messages alert you while the page is in the
background; sending or receiving a tomato or poop plays a short cue in the foreground.
Use the volume control and each sound's preview button to adjust it.

While watching a picture, **On screen** in its playback bar shows that room's
new messages over the picture. **Playback settings → On-screen chat** adjusts
their appearance. Loading earlier history does not replay these effects.
System video fullscreen and video picture in picture do not show chat overlays.

For each sound, **Choose file** selects a local audio file up to 256 KiB and three
seconds. Preview it or restore the built-in sound. Custom sounds stay in this
browser's site storage and are not sent to the room.

## Room voice

1. In the lower-left personal area, select **Join voice** and allow microphone
   access when asked. No one needs to open a room-wide call first.
2. Use the persistent voice controls to mute your microphone, pause listening
   or **Leave voice**. **Voice settings** selects the input and noise/echo processing.

![Example room conversation with joined voice controls below it: microphone, listening, settings and leave.](../assets/guide/channel-room.en.png#gh-light-mode-only)
![Example room conversation with joined voice controls below it: microphone, listening, settings and leave.](../assets/guide/channel-room.en.dark.png#gh-dark-mode-only)

Hover over a microphone, headphones or a person's speaker to adjust its volume;
on a touchscreen, press and hold. Muting a person changes only what you hear.
The arrow beside a room folds or expands its voice participant list.
Microphone and listening controls do not change the shared picture's sound.
Room managers can change **Room voice bitrate** in voice settings.
The microphone's green fill follows your voice level. Friends' microphone booms
light up as their voices arrive; an unfolded boom by itself means the microphone is on.

You can join voice in more than one room. When several are joined, use the voice
room selector to choose which room's microphone, listening and leave controls
you are changing. Switching the conversation or stopping a picture does not
leave those voice rooms. Leave each room when you are finished.

Browser microphone access requires a secure context, such as accepted HTTPS
or localhost. The [App reference](../../prototype/channel-server/README.md#local-app-link)
explains local access; [Native media setup](../../prototype/channel-native/README.md)
owns platform requirements.

### Source sound, commentary and room voice

- **Source sound** comes from the shared tab, application or screen and follows
  the picture's playback controls.
- **Include my microphone** adds commentary to your picture. Its viewers hear
  you without joining room voice; it ends when that share stops.
- **Room voice** is a separate conversation with its own membership and listening controls.

Enabling commentary and room voice together can send your voice twice. Keep
the one you need. Use headphones; system-sound capture can also recapture
voices playing in your browser. See [sharing sound controls](./sharing.md#exclude-a-voice-app-from-screen-audio).

## Keep the room beside a picture or game

In the full workspace, select **Pop out room** beside the couch to move its conversation, people and
voice controls directly into an always-on-top window. Other browsers use the
movable **Room panel** inside the page. Keep the original page open; closing
the small window, or pressing the same room-window button again, returns its
controls and drafts to the page.
In simple sharing, **Interact** first opens the inline panel while the couch
stays visible. Its picture-in-picture action can then move the room tool to a small window.

Opening or closing this window does not join or leave voice. A windowed or
borderless game lets you keep it visible; exclusive fullscreen may cover it.

## Let a friend control your shared screen

Share an App window or screen, enable **Remote control** on that share and
approve the friend's request. Room admission alone does not permit control.
The viewer requests control from that picture's playback bar and can select
**End control** when finished. The sharer can withdraw permission or stop that share.

See [Native input setup](../../prototype/channel-native/README.md) for platform
requirements. Another person's share has its own control permission.
