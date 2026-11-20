# Your first Piik room

English · [简体中文](./getting-started.zh-CN.md) · [Back to Piik](../../README.md)

- [Watch a friend’s screen](#join-a-friends-room)
- [Share from your browser](#use-piik-online) or [share with Piik App](#share-with-piik-app)

## Join a friend's room

1. Open the invitation in a browser on your phone or computer. You can watch without installing Piik App or creating an account.
2. If the first page asks for a **Site passphrase**, enter the passphrase for that Piik site. If the room asks for a **Room password**, choose **Enter room password** and enter the password for that room. Ask your friend for whichever the page requests. A link your friend copied with **Skip passwords** lets you skip both prompts.
3. You’re watching when your friend’s picture appears. If you see a **Play** button, press it. Tap the picture or move your pointer over it for [playback controls](./sharing.md#playback-controls).

If you received a four-digit room code, open the same Piik site your friend used, select **Join a room**, and enter the code. If the site asks for a passphrase first, enter it on the opening page.

[Get help joining or watching](./troubleshooting.md#common-problems).

## Use Piik online

1. Open [demo.piik.tv](https://demo.piik.tv) in your browser. You can share without an account or download.
2. Select **Start sharing**. Choose **Browser** to share a screen, window, or tab, or **Camera** to share your camera. Pick what you want viewers to see and enable audio if the picker offers it.
3. When your picture appears in the preview, select **Copy** in the **Admission** row and send the invitation to your friends. You can also show the room’s **QR code** for them to scan.
4. Keep the sharing tab open while friends watch. Select **Stop sharing** when you’re done.

For iPhone or iPad, see [screen sharing in Safari](./sharing.md#iphone-and-ipad-screen-sharing). If you can’t start sharing, see [sharing troubleshooting](./troubleshooting.md#starting-a-share).

![Pick a window, copy its invitation, and watch together.](../assets/quickstart.svg)

## Share with Piik App

On iPhone or iPad, [use Piik in Safari](#use-piik-online).

1. Download **Piik App** for your platform from
   [GitHub Releases](https://github.com/TNTcraftHIM/Piik/releases) or the
   [AtomGit mirror](https://atomgit.com/TNTcraftHIM/Piik/releases). On Android phones and tablets,
   install the APK directly. On a computer,
   extract the whole archive and keep its directory structure intact.
2. Open `piik-app.exe` on Windows, `Piik App.app` on macOS, or `./piik-app` on Linux.
   On Android phones and tablets, open Piik after installation. The launcher opens in your system browser.
3. Choose **Public invite** for friends outside your local network, then select
   **Open Piik**. Other modes are explained below.
4. Choose **Start sharing**, then select **Browser**, **Camera**, **Apps / Windows**, or
   **Screens** as available. Pick the actual source and sound option.
5. Copy and send the room invitation. Keep both the App and sharing tab open.

![App source selector with Browser, Camera, Apps / Windows and Screens tabs, window previews and source-audio controls.](../assets/guide/share-source.en.png#gh-light-mode-only)
![App source selector with Browser, Camera, Apps / Windows and Screens tabs, window previews and source-audio controls.](../assets/guide/share-source.en.dark.png#gh-dark-mode-only)

If macOS blocks the first launch, follow the [Mac opening steps](./troubleshooting.md#macos-blocks-first-launch).

<details>
<summary>Which download should I choose?</summary>

| Filename contains | Platform |
| --- | --- |
| `windows-amd64` | Windows x64 |
| `darwin-arm64` | Apple silicon; native capture requires macOS 13+ |
| `darwin-amd64` | Intel Mac; native capture requires macOS 13+ |
| `linux-amd64` | Linux x64 |
| `linux-arm64` | Linux ARM64 |
| `android-universal` | Android 10+; ARM64 and x64 in one APK |

Linux native capture also needs [system components](../../native/capture/linux/README.md).
See the [App guide](../../cmd/piik-app/README.md) for package and runtime details.

</details>

### Choose an App mode

![The App mode selector: Public invite is selected; Local room is the alternative.](../assets/guide/app-modes.en.png#gh-light-mode-only)
![The App mode selector: Public invite is selected; Local room is the alternative.](../assets/guide/app-modes.en.dark.png#gh-dark-mode-only)

- **Public invite:** send a temporary web link to friends elsewhere. It needs
  Internet access and lasts until you close the App.
- **Local room:** friends are on the same LAN or virtual LAN. Your computer
  must be reachable from theirs. If needed, expand **Local invitation address**
  and select the network interface your friends use.

For Local room and Public invite, expand **Site passphrase** to set an optional
access passphrase.
If your browser shows a warning, check with the host before opening the local invitation. [How to check a local invitation](./troubleshooting.md#local-https-certificate-warning)

<details>
<summary>Return to the launcher or change mode</summary>

Once the room service starts, click the connected **App** button at the top right
to return to the launcher, manage site access or reopen the room. The App terminal
also keeps an **App launcher** address. To change between Local room and Public
invite, close and reopen the App, then choose again. This ends the previous room
and generates a new public-invitation address.

</details>

### Use App with an existing site

1. Keep Piik App running and open the Piik site in your browser. Enter its site
   passphrase if asked; [Piik online](https://demo.piik.tv) needs no site passphrase.
   No room mode needs to be selected in the App launcher.
2. Click **App** at the top. Allow local-network access if the browser asks.
   When App is found, choose **Open App page**.
3. Check the site address on the local confirmation page, then choose **Allow access**.
4. Return to the site, choose **Start sharing**, then **Apps / Windows** or **Screens**.
   Select a source and send the new room invitation to your friends.

You can also choose **Connect Piik App** inside the **Start sharing** source
selector; its list updates as soon as the connection completes.
If connection fails, the App button offers **Retry** and **Download App**.
You can still share and watch in your browser.

Manage [approved sites and the startup favorite](../../cmd/piik-app/README.md#approved-site)
in the App launcher. If video cannot connect, use the [network guide](./network.md).

### Upgrading

App and site must use the same major version; **2.x and 1.x cannot be used together**.
To replace App or update a group's site, follow the [upgrade steps](../../cmd/piik-app/README.md#upgrading).

## Share from an existing site

Use an HTTPS Piik site provided by your group or administrator.
To run your own site, follow [self-hosting](../operations/self-hosting.md).

1. Open your group's Piik site. Enter its site passphrase if asked.
2. Choose **Start sharing**, then **Browser** to select a screen, window or tab,
   or **Camera** where your computer or phone browser supports it.
   Enable source audio if the picker offers it.
3. Check the preview, then choose **Copy invite link** and send it to your friends.
4. Keep the sharing tab open. Use **Pause sharing**, **Switch source**, or
   **Stop sharing** when you need them.

Screen capture requires an HTTPS site or `localhost`. The sources and audio
offered by the picker depend on your browser and operating system.
Invitation links grant access to that room; share them with the people you want there.

To use App capture on that same site, follow [Use App with an existing site](#use-app-with-an-existing-site).
The site manages rooms and invitations; the App supplies native capture.
If the site can relay video for viewers who cannot connect directly, turn off **Privacy mode** before
sharing to allow that option.

## Next steps

- [Sharing and playback](./sharing.md): picture settings, camera inputs and source sound.
- [Chat, voice and remote control](./room-tools.md): talk, react or let a friend take control.
- [Troubleshooting](./troubleshooting.md): start from the symptom you see.
