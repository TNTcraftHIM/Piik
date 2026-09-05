#include "vp8_encoder.h"

#include <algorithm>
#include <limits>
#include <stdexcept>
#include <string>
#include <thread>

#include <vpx/vp8cx.h>

namespace screener::capture {
namespace {

void CheckVpx(vpx_codec_err_t result) {
  if (result != VPX_CODEC_OK) {
    throw std::runtime_error(std::string("VP8 encoder: ") +
                             vpx_codec_err_to_string(result));
  }
}

}  // namespace

Vp8Encoder::Vp8Encoder(uint32_t width, uint32_t height, uint32_t frame_rate,
                       uint32_t bit_rate)
    : width_(width), height_(height), duration100ns_(0) {
  if (width == 0 || height == 0 || (width & 1) || (height & 1) ||
      frame_rate == 0 || bit_rate < 1'000) {
    throw std::runtime_error("VP8 encoder profile is invalid");
  }
  duration100ns_ = 10'000'000 / frame_rate;
  vpx_codec_enc_cfg_t config{};
  CheckVpx(vpx_codec_enc_config_default(vpx_codec_vp8_cx(), &config, 0));
  config.g_w = width;
  config.g_h = height;
  config.g_timebase = {1, 10'000'000};
  config.g_threads = std::min(4u, std::max(1u, std::thread::hardware_concurrency()));
  config.g_lag_in_frames = 0;
  config.rc_end_usage = VPX_CBR;
  config.rc_target_bitrate = bit_rate / 1'000;
  config.rc_dropframe_thresh = 0;
  // Use WebRTC's low-latency VP8 CBR buffer settings.
  config.rc_undershoot_pct = 100;
  config.rc_overshoot_pct = 15;
  config.rc_buf_initial_sz = 500;
  config.rc_buf_optimal_sz = 600;
  config.rc_buf_sz = 1000;
  config.kf_max_dist = frame_rate * 2;
  CheckVpx(vpx_codec_enc_init(&codec_, vpx_codec_vp8_cx(), &config, 0));
  const auto speed_result = vpx_codec_control(&codec_, VP8E_SET_CPUUSED, 8);
  if (speed_result != VPX_CODEC_OK) {
    vpx_codec_destroy(&codec_);
    CheckVpx(speed_result);
  }
}

Vp8Encoder::~Vp8Encoder() { vpx_codec_destroy(&codec_); }

const char* Vp8Encoder::Version() { return vpx_codec_version_str(); }

Vp8Frame Vp8Encoder::Encode(uint8_t* nv12, size_t row_pitch,
                           uint64_t timestamp100ns, bool key_frame) {
  if (nv12 == nullptr || row_pitch < width_ ||
      row_pitch > static_cast<size_t>(std::numeric_limits<int>::max()) ||
      timestamp100ns > static_cast<uint64_t>(std::numeric_limits<int64_t>::max())) {
    throw std::runtime_error("VP8 encoder input is invalid");
  }
  vpx_image_t image{};
  if (!vpx_img_wrap(&image, VPX_IMG_FMT_NV12, width_, height_, 1, nv12)) {
    throw std::runtime_error("VP8 encoder could not wrap NV12 input");
  }
  for (int plane = VPX_PLANE_Y; plane <= VPX_PLANE_V; ++plane) {
    image.stride[plane] = static_cast<int>(row_pitch);
  }
  image.planes[VPX_PLANE_U] = nv12 + row_pitch * height_;
  image.planes[VPX_PLANE_V] = image.planes[VPX_PLANE_U] + 1;
  CheckVpx(vpx_codec_encode(&codec_, &image,
                             static_cast<vpx_codec_pts_t>(timestamp100ns),
                             duration100ns_, key_frame ? VPX_EFLAG_FORCE_KF : 0,
                             VPX_DL_REALTIME));
  Vp8Frame frame;
  vpx_codec_iter_t iterator = nullptr;
  while (const auto* packet = vpx_codec_get_cx_data(&codec_, &iterator)) {
    if (packet->kind != VPX_CODEC_CX_FRAME_PKT) continue;
    if (!frame.bytes.empty() || packet->data.frame.pts !=
                                    static_cast<vpx_codec_pts_t>(timestamp100ns)) {
      throw std::runtime_error("VP8 encoder changed output order");
    }
    const auto* bytes = static_cast<const uint8_t*>(packet->data.frame.buf);
    frame.bytes.assign(bytes, bytes + packet->data.frame.sz);
    frame.key_frame = (packet->data.frame.flags & VPX_FRAME_IS_KEY) != 0;
  }
  if (frame.bytes.empty() || (key_frame && !frame.key_frame)) {
    throw std::runtime_error("VP8 encoder did not produce the requested frame");
  }
  return frame;
}

}  // namespace screener::capture
