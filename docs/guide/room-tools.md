# Chat, voice and remote control

This guide covers the 3.0 internal test. For the published version, use the [2.6.0 guide](https://github.com/TNTcraftHIM/Piik/blob/v2.6.0/docs/guide/room-tools.md).

English · [简体中文](./room-tools.zh-CN.md) · [Documentation](./README.md)

A domain contains rooms. Select a room in the sidebar to read its conversation.
Once admitted to that room, you can chat, join voice, share a picture or watch
someone else's share. Domain and room owners manage their respective settings;
you do not need a separate participant role to use these activities.

## Chat and reactions

1. Select a room and send a message in its conversation. Use the attachment
   button to add an image or file; you can include text with it.
2. Use **React to this message** to add a reaction. Select your reaction again
   to remove it.
3. To read back, select **Earlier messages**. **Latest messages** returns to
   the current conversation.

Confirmed messages and their reactions are saved by the room's host. Refreshing
or returning to the room loads its history again when that host is available.
Chat and history use the domain connection and do not wait for a P2P link.
The domain forwards message text; it does not keep the room's history.
An attachment's history entry can remain after its readable file copies go
offline; open or download it when a participant with a copy is available.
File content, voice and shared pictures use their own P2P connections.

Selecting a person in the room opens their interaction menu. Expressions and
thrown props are live effects; they are not saved as message reactions.

While watching a picture, **On screen** in its playback bar shows that room's
new messages over the picture. **Playback settings → On-screen chat** adjusts
their appearance. Loading earlier history does not replay these effects.
System video fullscreen and video picture in picture do not show chat overlays.

## Room voice

1. In the selected room's header, select **Join voice** and allow microphone
   access when asked. No one needs to open a room-wide call first.
2. To join without capturing a microphone, open the arrow beside **Join voice**
   and select **Listen without a microphone**.
3. Use the persistent voice controls to mute your microphone, pause listening
   or **Leave voice**. **Voice settings** selects the input and noise/echo processing.

![Example room conversation with joined voice controls below it: microphone, listening, settings and leave.](../assets/guide/channel-room.en.png#gh-light-mode-only)
![Example room conversation with joined voice controls below it: microphone, listening, settings and leave.](../assets/guide/channel-room.en.dark.png#gh-dark-mode-only)

Hover over a microphone, headphones or a person's speaker to adjust its volume;
on a touchscreen, press and hold. Muting a person changes only what you hear.
Microphone and listening controls do not change the shared picture's sound.
Room managers can change **Room voice bitrate** in voice settings.

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

Select **Mini window** in the room header to move its conversation, people and
voice controls into a movable room window. On supported desktop browsers,
**Open in always-on-top window** detaches it. Keep the original page open;
closing the small window returns its controls to the page.

Opening or closing this window does not join or leave voice. A windowed or
borderless game lets you keep it visible; exclusive fullscreen may cover it.

## Let a friend control your shared screen

Share an App window or screen, enable **Remote control** on that share and
approve the friend's request. Room admission alone does not permit control.
The viewer requests control from that picture's playback bar and can select
**End control** when finished. The sharer can withdraw permission or stop that share.

See [Native input setup](../../prototype/channel-native/README.md) for platform
requirements. Another person's share has its own control permission.
