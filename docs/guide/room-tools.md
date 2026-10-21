# Chat, voice and remote control

English · [简体中文](./room-tools.zh-CN.md) · [Documentation](./README.md)

These tools belong to the room. You can chat before or after a picture share;
remote control requires an active App window or screen share.

## Chat and reactions

Once the host creates a room, participants can select **Interact** below the
sofa to send messages. Select a person on the sofa to open their reaction menu:
your own reactions appear above you; reactions sent to a friend fly towards them.
Chat and voice avatars also open a quick reaction menu; **More reactions**
shows the full palette while the conversation stays available.
The interaction window can be moved and resized without rearranging the page.

Supported desktop browsers show **Open in always-on-top window** in its top-right
corner. You can read messages, see reactions and select someone to interact with
while playing. Keep the Piik page open; closing the small window returns it to the page.
Use a windowed or borderless game; exclusive fullscreen may cover the window.
The window cannot show the game through its background or let mouse clicks pass through.

**On screen**, beside the message box or in the viewer's playback bar, shows new
messages over the picture. It is off by default and only changes your own view.
The settings button beside the Chat/Voice tabs opens the current page's settings;
**Back** returns to that page. **Chat settings** contains text size and opacity.
Playback settings remain dedicated to picture display and connection preferences.
System video fullscreen and picture in picture cannot show these overlays.

Stopping a share keeps the room's chat available. App Local and Public invite
rooms require the App to stay open. Each page retains only its latest received
messages: refreshing clears them, and late joiners receive no earlier history.
To keep a copy, use **Chat settings → Export chat** to save the latest messages
retained on this page (up to 1,000) as a text file.
Chat travels through the room's server and is **not end-to-end encrypted**.

## Room voice in test builds

The Host may choose **Create room** before sharing, then copy its invitation.
Open **Interact → Voice** and select **Open room voice**. Room members can then
select **Join voice**, without another approval.
Joining never opens a microphone: each speaker selects the **Microphone** button
and grants browser access. A person's speaker button mutes them only for you.
Microphone capture needs a browser-accepted HTTPS or localhost page; ordinary
LAN HTTP pages can still join and listen. For voice input or remote control over
a LAN or virtual LAN, see the [virtual-LAN options](./troubleshooting.md#optional-a-virtual-lan).
After joining, the bottom toolbar provides microphone, listening and leave
controls. The headphone button pauses room voice locally; your microphone, video
sound and voice forwarding remain unaffected. **Voice settings**
offers input device, microphone and listening volumes (both 0%–200%, default
100%), and noise/echo reduction. Listening volume only changes room voice for
you. The microphone icon's green fill rises with your actual input level;
a slashed icon means the microphone is off. Browser and App-backed sharing use
these same controls. Hover over a microphone, headphone or person's speaker
button to adjust its volume directly; on touchscreens, press and hold it.
A person's local 0%–200% level combines with the master listening level and
does not change what anyone else hears. Participant microphone status stays
visible while the green dot indicates speech.

Voice stays connected when picture sharing stops. It also stays active when you
close or detach the interaction window. Viewers choose **Leave voice** to leave;
the Host's **Close room voice** ends voice for everyone. Reopening does not
rejoin Viewers or turn on their microphones.
Host speech uses this same room microphone; viewers join voice to hear it.
Source sound stays with the picture. Room voice favors timely conversation and
can arrive ahead of a delayed picture. Use headphones; whole-system sound sharing can include
received voices, so [audio exclusion](./sharing.md#exclude-a-voice-app-from-screen-audio)
may help on supported App capture paths.

Microphone and master listening settings stay in this browser on the current
site; person volumes apply to current room participants. Settings never reopen
your microphone automatically. Keep noise and echo reduction on for ordinary
speech, or turn it off when the selected input already processes your voice.

## Let a friend control your shared screen

1. Share through Piik App using **Apps / Windows** or **Screens**.
2. Open **Remote control** below the picture and turn it on. It starts with
   **Ask each time**.
3. Your friend selects **Request control** in their playback bar. Choose
   **Allow control** on your sharing page when their request arrives.

When sharing a window, switch back to that window after allowing control. Input
pauses while another window is active and resumes when you return.

One viewer can control at a time, using a desktop or mobile browser. Update the
host's App and the room's site, then refresh the viewing page. The control button
appears when the host enables control and the connection supports it. Browser
and camera capture cannot receive remote input.
Viewers need HTTPS or a localhost page for remote control. A LAN or virtual-IP
HTTP page can play video but lacks the browser cryptography interface required
for remote control, so no control button appears.

Either person can choose **End control**. On the host's computer, **Ctrl+Alt+F10**
on Windows or **Control+Option+F10** on macOS also stops control by default.
Change the function key in the host's **Remote control** panel if it conflicts
with another app. Shortcut choices are saved in this site's browser storage;
each site is configured independently. The viewer can separately change **Exit control shortcut**
in **Remote keyboard**, including its detached window. Changing the
shared source or stopping sharing turns remote control off. After a connection
interruption, the viewer requests control again.
The authorization choice is remembered, but remote control does not turn on
automatically. If the previous choice was **Room Viewers**, enabling it shows
the permission explanation first; select **Allow Viewers** to
apply it. Control passwords are not saved.

On a phone, swipe to move the pointer, tap to click and hold to drag. Two-finger
tap is right-click; two-finger swipe scrolls. Pinch to zoom, then use two fingers
to move around the enlarged picture. **Remote keyboard** provides keys,
shortcuts and text input. On a computer, **Game mouse** captures continuous
mouse movement; press **Esc** to release it.

<details>
<summary>Permissions and platform support</summary>

**Room Viewers** allows a room member to take idle control without asking each
time; **Password** requires a separate control password. These choices apply
only to the current shared source. Control gives access to the computer's mouse
and keyboard, so allow people you trust. It is not limited to what is visible
inside the video.

macOS asks for Accessibility permission. Linux needs a supported desktop Portal
and currently controls a selected screen, not an application window. Windows
is the primary physically tested host; macOS/Linux device acceptance is still
limited. System-protected shortcuts and some games may not accept remote input.

</details>
