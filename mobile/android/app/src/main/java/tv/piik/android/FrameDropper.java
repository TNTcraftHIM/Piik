package tv.piik.android;

/** Thin binding to the pinned WebRTC FrameDropper; owned only by the capture GL thread. */
final class FrameDropper implements AutoCloseable {
  static {
    System.loadLibrary("piik_frame_dropper");
  }

  private long handle;

  FrameDropper(int bitrate, int framerate) {
    handle = create(bitrate, framerate);
    if (handle == 0) throw new IllegalStateException("Could not initialize encoder rate control");
  }

  boolean shouldEncode(long timestamp, boolean recovery) {
    return shouldEncodeNative(handle, timestamp, recovery);
  }

  void encoded(int bytes, boolean keyframe) {
    fill(handle, bytes, keyframe);
  }

  void bitrate(int bitrate) {
    setBitrate(handle, bitrate);
  }

  @Override
  public void close() {
    destroy(handle);
    handle = 0;
  }

  private static native long create(int bitrate, int framerate);
  private static native boolean shouldEncodeNative(long handle, long timestamp, boolean recovery);
  private static native void fill(long handle, int bytes, boolean keyframe);
  private static native void setBitrate(long handle, int bitrate);
  private static native void destroy(long handle);
}
