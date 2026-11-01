# H.264 display aperture fixture

`aperture.h264` is one generated Constrained Baseline frame with 3856×2176
encoded storage and a 3840×2160 visible aperture at (0, 0). The visible picture
is red; the right/bottom padding is blue. It contains no screen recording or user data.

The Windows output-worker test decodes it through Media Foundation and verifies
the dimensions and NV12 pixels handed to downstream encoders. The macOS geometry
self-test uses its SPS/PPS to check CoreMedia's format interpretation without
allocating a hardware decoder. Use the retained [Windows helper](../../capture/windows/README.md) build checks or [macOS helper](../../capture/darwin/README.md) geometry self-test on the respective platform.

To regenerate with FFmpeg and libx264:

```sh
ffmpeg -f lavfi -i color=c=blue:s=3856x2176:r=24 \
  -vf drawbox=x=0:y=0:w=3840:h=2160:color=red:t=fill \
  -frames:v 1 -c:v libx264 -profile:v baseline -level:v 5.1 \
  -preset medium -tune zerolatency -threads 2 \
  -bsf:v h264_metadata=crop_right=16:crop_bottom=16 \
  aperture.h264
```
