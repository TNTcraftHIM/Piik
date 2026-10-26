#include <jni.h>
#include <algorithm>
#include <cstdint>
#include <new>

#include "modules/video_coding/utility/frame_dropper.h"

namespace {
// Calls are serialized by CaptureRenderer's GL queue, including final deletion.
struct EncoderRate {
  webrtc::FrameDropper dropper;
  int bitrate;
  float framerate;
  int64_t last_input = 0;

  EncoderRate(int rate, int fps) : bitrate(rate), framerate(fps) {
    dropper.SetRates(bitrate / 1000.0f, framerate);
  }
};

EncoderRate* state(jlong handle) {
  return reinterpret_cast<EncoderRate*>(handle);
}
}  // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_tv_piik_android_FrameDropper_create(JNIEnv*, jclass, jint bitrate, jint fps) {
  return reinterpret_cast<jlong>(new (std::nothrow) EncoderRate(bitrate, fps));
}

extern "C" JNIEXPORT jboolean JNICALL
Java_tv_piik_android_FrameDropper_shouldEncodeNative(JNIEnv*, jclass, jlong handle,
                                               jlong timestamp, jboolean recovery) {
  EncoderRate& rate = *state(handle);
  if (!recovery && rate.last_input > 0 && timestamp > rate.last_input) {
    // Leak against observed capture cadence, not a configured encoder ceiling.
    rate.framerate = std::max(1.0f, 1.0e9f / (timestamp - rate.last_input));
  }
  rate.last_input = timestamp;
  rate.dropper.SetRates(rate.bitrate / 1000.0f, rate.framerate);
  rate.dropper.Leak(static_cast<uint32_t>(rate.framerate + 0.5f));
  bool drop = rate.dropper.DropFrame();
  return recovery || !drop;
}

extern "C" JNIEXPORT void JNICALL
Java_tv_piik_android_FrameDropper_fill(JNIEnv*, jclass, jlong handle, jint bytes,
                                      jboolean keyframe) {
  state(handle)->dropper.Fill(bytes, !keyframe);
}

extern "C" JNIEXPORT void JNICALL
Java_tv_piik_android_FrameDropper_setBitrate(JNIEnv*, jclass, jlong handle, jint bitrate) {
  EncoderRate& rate = *state(handle);
  rate.bitrate = bitrate;
  rate.dropper.SetRates(bitrate / 1000.0f, rate.framerate);
}

extern "C" JNIEXPORT void JNICALL
Java_tv_piik_android_FrameDropper_destroy(JNIEnv*, jclass, jlong handle) {
  delete state(handle);
}
