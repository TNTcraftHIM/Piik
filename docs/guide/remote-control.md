# Remote control and playing together

English · [简体中文](./remote-control.zh-CN.md) · [Documentation](./README.md)

Let a friend operate your shared computer, or play a local multiplayer game
together. The Host shares an App window or screen; friends join in their browsers.

## Start remote control

1. Share through Piik App using **Apps / Windows** or **Screens**.
2. Open **Remote control** below the picture and turn it on. It starts with
   **Ask each time**.
3. Your friend selects **Request control** in their playback bar. On the Host
   page, choose **Allow** when the request arrives.

When sharing a window, switch back to it after allowing control. Input pauses
while another window is active and resumes when you return.

Use an up-to-date App and room site, and refresh the viewing page after updating.
Viewers need HTTPS or a localhost page for the encrypted input connection.
Ordinary LAN HTTP can play video but cannot offer remote control. Browser and
camera capture cannot receive remote input.

## Play together

1. Enable **Remote control** as above, then turn on **Allow simultaneous control**.
   This setting starts off for each source. Changing it ends current requests and
   control grants; the authorization mode and password stay in place.
2. Each friend selects **Request control**. Approve them using the same
   authorization choice as ordinary remote control.
3. In the game, assign different keyboard bindings to each player, such as
   WASD and arrow keys. The game must support sharing one keyboard.

The Host and approved friends share the computer's existing keyboard and mouse.
Each friend's held keys and mouse buttons are tracked separately, so leaving
releases only their input. Keyboard and mouse co-play needs no extra driver.
One approval gives a Viewer remote control through keyboard, mouse and an
optional supported gamepad. **Allow simultaneous control** counts approved
Viewers, not their input devices. Text insertion is available with one approved
Viewer and pauses with two or more; physical keyboard keys remain usable.
Older clients retain one-controller behavior. Update the Host's App and room
site to versions that support playing together, then refresh each viewing page.

Everyone controls the same mouse pointer; movements and clicks from approved
players apply together. Use the Host's stop action or shortcut to end control.

Approved participants have a mouse emblem on their couch avatar.
Both Host and Viewers can see who has joined; ending control removes the marker.

## Gamepads

The Host installs any required external input components from their official
source. Piik does not bundle, download or install third-party gamepad SDKs or
drivers on any platform.

| Host system | Current gamepad support |
| --- | --- |
| Windows x64 | Install [ViGEmBus 1.22.0](https://github.com/nefarius/ViGEmBus/releases/tag/v1.22.0); no extra client DLL is needed. |
| Linux | The prototype uses system uinput; the App's user needs write access to the device. |
| macOS | Independent gamepads are not available in the current App; the native backend needs Apple authorization. |

Each remote player can use one browser-recognized controller as a separate
Xbox 360 controller on a **Windows x64 Host**. Piik transports and maps its input;
the Host's optional ViGEmBus driver creates the virtual device.

1. On the Host, install the official
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
connected to the Host. Disconnect an unused controller or end that Viewer's
remote control to free a slot. Piik does not
choose the game's player number; use the game's join and assignment controls.
Each approved Viewer uses their own virtual controller. Disconnecting the
controller removes that device while remote-control permission remains; ending remote
control releases all of that Viewer's input. Losing page or shared-window focus
returns the controller to neutral.

If the gamepad does not respond, check the Host's driver and App support, then
turn **Remote control** off and on. Keyboard/mouse co-play and ordinary remote control
remain available without the gamepad driver.

## End control

Either person can choose **End control**. The Host can stop all remote input with
**Ctrl+Alt+F10** on Windows or **Control+Option+F10** on macOS. Change the function
key in the Host's **Remote control** panel if it conflicts with another app.
The Viewer can set a separate **Exit control shortcut** in **Remote keyboard**.
Shortcut choices are saved per site in this browser.

Changing the source or stopping sharing turns control off. After a connection
interruption, players request control again. The authorization choice is
remembered, but control never turns on automatically. A remembered **Room Viewers**
choice needs **Allow Viewers** before it applies again. Passwords are not saved.

## Mouse, touch and permissions

On a phone, swipe to move the pointer, tap to click and hold to drag. Two-finger
tap is right-click; two-finger swipe scrolls. Pinch to zoom, then use two fingers
to move around the enlarged picture. Open the mouse from the picture's right
edge for left, middle and right buttons and a scroll area. Drag its lower shell
to move the pointer; hold a button while moving to drag an item. The scroll area
also works while zoomed in. Tap the edge arrow to tuck the mouse away; touch
gestures and the pointer remain available. **Remote keyboard** provides keys,
shortcuts and text entry.
On a computer, **Game mouse** captures continuous mouse movement;
press **Esc** to release it.

**Room Viewers** lets authenticated room members take available control without
asking each time. **Password** requires a separate control password. Both apply
only to the current shared source. Keyboard and mouse access can operate the
computer beyond the video boundary, so authorize people you trust.

macOS requires Accessibility permission. Linux requires a supported desktop
Portal and controls a selected screen rather than an application window.
System-protected shortcuts and some games do not accept injected input.
