# Remote control and playing together

English · [简体中文](./remote-control.zh-CN.md) · [Documentation](./README.md)

This guide covers the 3.0 test version. For published 2.x, use the
[2.6.0 guide](https://github.com/TNTcraftHIM/Piik/blob/v2.6.0/docs/guide/remote-control.md).

Let a friend operate your shared computer, or play a local multiplayer game
together. Each sharer controls access to their own picture, independently of
domain or room ownership. Friends watch and request control in their browsers.

## Start remote control

1. Share through Piik App on a supported computer using **Apps / Windows** or **Screens**.
2. Open **Remote control** below your picture and turn it on. It starts with
   **Ask each time**.
3. Your friend selects **Watch** on that picture, then **Request control** in
   its playback bar. Choose **Allow** when their request appears on your page.

When sharing a window, switch back to it after allowing control. Input pauses
while another window is active and resumes when you return.

Use an up-to-date App and room site, and refresh the viewing page after updating.
Viewers need HTTPS or a localhost page for the encrypted input connection.
Ordinary LAN HTTP can play video but cannot offer remote control. Browser and
camera capture cannot receive remote input. Android can share and act as a
controller, but it cannot receive remote keyboard or mouse input.

## Play together

1. Enable **Remote control** as above, then turn on **Allow simultaneous control**.
   This setting starts off for each source. Changing it ends current requests and
   control grants; the authorization mode and password stay in place.
2. Each friend selects **Request control**. Approve them using the same
   authorization choice as ordinary remote control.
3. In the game, assign different keyboard bindings to each player, such as
   WASD and arrow keys. The game must support sharing one keyboard.

The sharer and approved friends share the computer's existing keyboard and mouse.
Each friend's held keys and mouse buttons are tracked separately, so leaving
releases only their input. Keyboard and mouse co-play needs no extra driver.
One approval gives a Viewer remote control through keyboard, mouse and an
optional supported gamepad. **Allow simultaneous control** counts approved
Viewers, not their input devices. Text insertion is available with one approved
Viewer and pauses with two or more; physical keyboard keys remain usable.

Everyone controls the same mouse pointer; movements and clicks from approved
players apply together. The sharer can use the stop action or shortcut to end control.

Approved participants have a mouse emblem on their couch avatar.
Everyone in the room can see who has joined; ending control removes the marker.

## Gamepads

The sharer installs any required external input components from their official
source. Piik does not bundle, download or install third-party gamepad SDKs or
drivers on any platform.

| Shared computer | Current gamepad support |
| --- | --- |
| Windows x64 | Install [ViGEmBus 1.22.0](https://github.com/nefarius/ViGEmBus/releases/tag/v1.22.0); no extra client DLL is needed. |
| Linux | Keyboard and mouse use the desktop Portal; virtual gamepads are not enabled in this App. |
| macOS | Independent gamepads are not available in the current App; the native backend needs Apple authorization. |

Each remote player can use one browser-recognized controller as a separate
Xbox 360 controller on the shared **Windows x64 computer**. Piik transports and
maps its input; the optional ViGEmBus driver creates the virtual device.

1. On the shared computer, install the official
   [ViGEmBus 1.22.0 release](https://github.com/nefarius/ViGEmBus/releases/tag/v1.22.0)
   and follow its restart prompt. ViGEm is end-of-life; 1.22.0 is its final
   installer and removes the old updater. If it is already installed, reuse it.
2. Extract and open the updated Windows x64 Piik App package, then enable
   **Remote control**. App detects the installed driver; no DLL
   copying or SDK configuration is needed.
3. On each friend's computer, connect a standard-layout gamepad, open the
   viewing page and press a controller button so the browser recognizes it.
   Obtain remote-control approval; Piik automatically uses the first connected
   controller with the browser's standard mapping. No additional approval is needed.
4. Keep the viewing page focused. In the game, join as a controller player.

XInput has four controller slots in total, including controllers already
connected to that computer. Disconnect an unused controller or end that Viewer's
remote control to free a slot. Piik does not
choose the game's player number; use the game's join and assignment controls.
Each approved Viewer uses their own virtual controller. Disconnecting the
controller removes that device while remote-control permission remains; ending remote
control releases all of that Viewer's input. Losing page or shared-window focus
returns the controller to neutral.

If the gamepad does not respond, check the shared computer's driver and App support, then
turn **Remote control** off and on. Keyboard/mouse co-play and ordinary remote control
remain available without the gamepad driver.

## End control

Either person can choose **End control**. The sharer can stop all remote input with
**Ctrl+Alt+F10** on Windows or **Control+Option+F10** on macOS. Change the function
key in the sharer's **Remote control** panel if it conflicts with another app.
The Viewer can set a separate **Exit control shortcut** in **Remote keyboard**.
Shortcut choices are saved per site in this browser.
On Linux, use the system shortcut shown in the control panel; the desktop may
ask you to choose or approve its binding.

Changing the source or stopping sharing turns control off. If the input
connection closes, players request control again. The authorization choice is
remembered, but control never turns on automatically. A remembered **Room Viewers**
choice needs **Allow Viewers** before it applies again. Passwords are not saved.

## Mouse, touch and permissions

### Direct touch

| Gesture | Action |
| --- | --- |
| Tap / hold and move | Click / drag an item. |
| Two-finger tap | Right-click. |
| Two-finger swipe | Scroll; when zoomed in, pan the picture. |
| Pinch | Zoom the picture in or out. |

Direct touch has no cursor. **Playback settings → Default touch mode → Trackpad**
selects cursor-based touch control instead.

### Virtual mouse and keyboard

Drag the mini mouse to reposition it; tap to expand its left and right buttons
and combined scroll wheel / middle button. The cursor stays above and to the
left of the mouse and moves with it. The picture pans at the edges to leave room
for the tool, and the cursor stops at the source picture's edges. With the mouse
expanded, use two fingers on the picture to pan or zoom while the mouse stays
in reach. Use its wheel to scroll the remote screen. Drag the lower shell to move; hold a
mouse button while moving to drag an item. Tap the wheel to middle-click, swipe
it to scroll, or hold then
move for a middle-button drag. The separate minimize button returns it to the mini
mouse and your selected touch mode. Leave the mini mouse at an edge to tuck it away
after the same idle delay as the player controls; tap the visible part to expand
it again. **Remote keyboard** provides keys,
shortcuts and text entry.
On a computer, **Game mouse** captures continuous mouse movement;
press **Esc** to release it.

### Who can control

**Room Viewers** lets authenticated room members take available control without
asking each time. **Password** requires a separate control password. Both apply
only to the current shared source. Keyboard and mouse access can operate the
computer beyond the video boundary, so authorize people you trust.

macOS requires Accessibility permission. Linux requires a supported desktop
Portal and controls a selected screen rather than an application window.
System-protected shortcuts and some games do not accept injected input.
