# Native H.264 Opt-In Path

## 2026-08-21 Native Window Source

The Native sender now has two explicit local video sources. Browser VP8 remains
the default; browser H.264 remains available as the earlier opt-in. The new
`native-window-h264` source is Windows 11-only and requires the user to select
one local opaque window target. It never silently replaces a browser source or
falls back to software encode, another codec, monitor capture, or system audio.

The native-window path is:

```text
opaque local target -> HWND + PID + process creation time
  -> WGC BGRA surface on one selected D3D11 adapter
  -> D3D11 VideoProcessor 1280x720 NV12
  -> adapter-bound hardware-only MF H.264 42c01f Annex-B
  -> generation-bound Go Session.WriteMedia
  -> one Go queue and Pion H264Payloader
  -> one TrackLocalStaticRTP
  -> at most two independent PeerConnections
```

The helper revalidates HWND-to-PID and PID creation time immediately before WGC
activation. The same process identity feeds WASAPI application loopback with
`INCLUDE_TARGET_PROCESS_TREE`. One private stdout protocol multiplexes bounded
PCM, H.264 access units, and local hardware status. PID, HWND, creation time,
adapter/MFT identity, PCM, and status never enter signaling. Go sends H.264
directly to the existing fanout; a second local copy travels only to the sender
UI's `VideoDecoder` preview and never returns to Go. PCM retains the existing
local WebCodecs Opus bridge.

PLI/FIR and fanout recovery requests enter the generation-bound helper stdin as
one coalesced `K` command. The helper forces an in-band SPS/PPS/IDR recovery
unit, while the existing Pion `H264Payloader`, exact `42c01f` MediaEngine, one
shared track, and two-edge cap remain unchanged. Browser VP8/H.264 use their
existing `getDisplayMedia` and `VideoEncoder` path.

Both the product helper and offline fixture compile the same MF encoder source.
The product build and the fixture build pass MSVC `/W4 /WX`; focused Go tests
cover bound target arguments, multiplexed protocol bounds, key-frame command
forwarding, generation/source validation, and the peer-assisted Host contract.

## Native Window Acceptance Evidence

One bounded Chrome 151 run used a real animated top-level window, process-tree
audio, the explicit Native source, and the peer-assisted direct-child wire. It
created no browser capture or `VideoEncoder`; the ordinary Viewer received
1,313 packets/1,431,696 bytes during the sample, decoded and rendered 203
1280x720 frames, and received 500 Opus packets without a fatal/encoder error.
The helper wrote 30 frames and 174 source RTP packets before the retained
sender-start snapshot.

The exact helper process was PID 15060. Its Windows GPU Engine instance
`pid_15060_luid_0x00000000_0x0001a496_phys_0_eng_6_engtype_videoencode`
reached 2.98028% utilization; the helper's independently validated adapter
status was `0x00000000:0x0001a496`. This is process-and-adapter-correlated
hardware evidence, not a throughput or performance claim. The generic gate
reported failure only because its asynchronous Pion diagnostics delta stayed
zero after the Viewer counters advanced; the run was not repeated for that
known sampling residue.

Primary sources checked 2026-08-21:

- [Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture)
- [`IGraphicsCaptureItemInterop::CreateForWindow`](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow)
- [`Direct3D11CaptureFramePool::CreateFreeThreaded`](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.createfreethreaded)
- [`CreateDirect3D11DeviceFromDXGIDevice`](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.directx.direct3d11.interop/nf-windows-graphics-directx-direct3d11-interop-createdirect3d11devicefromdxgidevice)
- [Microsoft MIT HWND capture sample](https://github.com/microsoft/Windows.UI.Composition-Win32-Samples/tree/master/cpp/ScreenCaptureforHWND)
- [`ID3D11VideoDevice::CreateVideoProcessorInputView`](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11videodevice-createvideoprocessorinputview)
- [`ID3D11VideoContext::VideoProcessorSetOutputBackgroundColor`](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11videocontext-videoprocessorsetoutputbackgroundcolor)

## 2026-08-21 Browser H.264 Source

The earlier browser H.264 source remains an explicit option. Its loopback path
is Chrome WebCodecs Annex-B -> the local envelope -> the same Go/Pion fanout.

## Bounded Loopback Evidence

One short Chrome 151 one-viewer gate ran on 2026-08-20/21 with the in-memory
development server, no peer assistance, no TURN, and a synthetic animated
1280x720 source. The H.264 sender configuration was 720p30, 3 Mbps, one
encoder instance, Annex-B output, and `hardwareAcceleration: prefer-hardware`.

Retained evidence:

| Boundary | Result |
| --- | --- |
| Sender configuration / encoder | H.264 config accepted; one encoder; 18 frames written; 156 source RTP packets; 174,978 source RTP bytes; zero encoder/fatal errors |
| Signaling and ICE | Host authentication, room creation, offer/answer, trickle ICE, and both peer connections reached connected |
| Viewer media | 2,690 inbound packets, about 3.0 MiB, 299 decoded and 298 rendered frames, 1280x720 |
| Resource/lifecycle | One host edge; cleanup completed; no production endpoint or TURN allocation |

The generic gate reported failure only because its two-second Pion diagnostics
snapshot did not refresh during the final sample (`pionPacketDelta=0`), the same
probe-timing residual retained by the earlier VP8 run. All independent viewer
receive/decode/render and sender checks passed. This is one functional
loopback, not a public-network, multi-viewer, endurance, or codec benchmark.

## Hardware Boundary

The Media Foundation/NVIDIA fixture established the physical hardware gate and
the exact `42c01f` in-band recovery contract. Browser H.264 still has only a
hardware preference. The native-window source instead enumerates only an
adapter-LUID-bound hardware MFT, requires D3D11 awareness and exact codec
readback, and has no software retry. The Native acceptance run above adds the
required product-process `VideoEncode` attribution; fixture evidence remains a
separate encoder-contract measurement.

## Scope

- Browser VP8 remains the default and no production deployment switch is made.
- No SFU, TURN, Web viewer, access protocol, or default VP8 behavior changed.
- No codec matrix, benchmark, second viewer, or endurance run is required for
  this landing slice.
- The Native source reuses existing controller compatibility and evaluation
  packaging changes; it adds no topology.
- H.264 distribution still carries the existing patent/license review boundary.

---
