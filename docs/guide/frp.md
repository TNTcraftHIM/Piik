# Use frp for a fixed Piik invitation address

English · [简体中文](./frp.zh-CN.md) · [Documentation](./README.md)

Use frp to give a desktop Piik App or a privately hosted Piik Server a fixed public address. Set up the tunnel on the hosting side. Your friends open the room invitation in their browsers.

| Where it goes | What to enter |
| --- | --- |
| Local target in frp | The local IP and port of the Piik **website**. This guide uses `127.0.0.1:8787` with the tunnel client on the Piik machine. |
| Public address in Piik | The HTTPS hostname your friends can reach, including the assigned public port. Replace the example `https://piik.example.nyat.app:21080` with yours. |

## Get a public address

This example uses **SakuraFrp (樱花映射)**. If you run frps or use another provider, forward the website and WebSocket traffic for the same public HTTPS address to Piik's local HTTP service, then continue to the Piik settings. [Self-hosted frps setup](../operations/self-hosting.md#optional-forward-an-existing-server-with-frp)

1. Open the SakuraFrp launcher on the Piik machine. Sign in with the access key on the **用户信息** (User information) page of your SakuraFrp dashboard. [Launcher walkthrough](https://doc.natfrp.com/launcher/usage.html)
2. In **隧道列表** (Tunnels), create a **TCP** tunnel on a node that permits websites. Use `127.0.0.1` and Piik's local web port. Leave the remote port empty for SakuraFrp to assign it and set **自动 HTTPS** (Automatic HTTPS) to **自动** (Auto). Friends connect over HTTPS and Piik receives HTTP locally. [Web tunnel settings](https://doc.natfrp.com/app/http.html) · [Automatic HTTPS](https://doc.natfrp.com/frpc/auto-https.html)
3. Under **子域绑定** (Subdomain binding), request a `nyat.app` subdomain. Select **新建绑定** (New binding) and choose your tunnel. Start or restart the tunnel. Once the log confirms it loaded the certificate for your subdomain, copy the **hostname and public port** from the log and prepend `https://`. [Subdomain and certificate walkthrough](https://doc.natfrp.com/bestpractice/domain-bind.html)

## Set the invitation address in Piik

### Desktop App

- **3.0 beta.** In the launcher choose **Public invite → Existing address** and enter your public HTTPS address. Match the tunnel's local target to the **Local forwarding target** shown in Piik, then enter Piik from the launcher. The host uses the page the App opens.
- **2.8 and later 2.x releases.** Open PowerShell in the extracted App directory and run the command below. Replace the example HTTPS address with the public address from the tunnel log and replace the example port with the local port in the TCP tunnel settings. With v2.7.0, use the Server option below for a fixed address.

```powershell
.\piik-app.exe --link --public-origin https://piik.example.nyat.app:21080 --port 8787
```

### Existing Server

Apply the settings for your Server version to its existing configuration and restart the service. For a container deployment, point frp at the Piik web port published on the host.

| Version | Local web port | Public invitation address |
| --- | --- | --- |
| 2.x Server | `PORT=8787` | `PUBLIC_BASE_URL=https://piik.example.nyat.app:21080` |
| 3.0 Server | `PIIK_CHANNEL_PORT=8787` | `PIIK_CHANNEL_INVITATION_ORIGIN=https://piik.example.nyat.app:21080` |

Enter the origin through the port. Piik adds the room path and any private invitation details when you copy the invitation.

## Test from another network

Copy the **full invitation** from the room or show its QR code. Ask a friend to open it over cellular data. Entering the room and receiving a new chat message verifies the website and signaling path. Keep Piik and the tunnel running, start a share, then check picture and sound.

- **The site fails to load or the certificate is untrusted.** Check the invitation's hostname and public port. Look in the SakuraFrp log for a running tunnel and a certificate loaded for that subdomain. [SakuraFrp troubleshooting](https://doc.natfrp.com/faq/site-inaccessible.html)
- **Chat works but the picture will not connect.** The web tunnel is working. Picture and sound use WebRTC. Try switching one device to a phone hotspot. [Media network checks](./network.md)

<details>
<summary>Relay media through frp on a Server</summary>

Create a separate UDP tunnel and note the public IP and UDP port assigned by the provider. Keep the existing address for the web tunnel.

- **2.x Server.** Set both the tunnel's local port and `SFU_UDP_PORT` to its assigned public UDP port. Set `SFU_PUBLIC_IP` to the node's public IPv4 address. [2.x media forwarding settings](../operations/self-hosting.md#using-a-managed-frp-provider)
- **3.0 Server.** Forward the tunnel to `PIIK_CHANNEL_UDP_PORT` and set `PIIK_CHANNEL_UDP_PUBLIC_ADDRESS` to the actual public `IP:port`. Enable `PIIK_CHANNEL_SERVICE_TRANSIT=true` on the Server; rooms then use site forwarding unless their owner turns it off in room settings.

</details>
