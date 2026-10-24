package tv.piik.android;

import java.lang.ref.WeakReference;
import tv.piik.androidbridge.Platform;
import tv.piik.androidbridge.Runtime;

// Each JNI adapter belongs to one Go runtime, even when stream IDs restart at one.
final class CapturePlatform implements Platform {
  volatile WeakReference<Runtime> owner = new WeakReference<>(null);

  public void startVideo(long id, String config) {
    Runtime runtime = owner.get();
    MainActivity.main.post(
        () -> {
          if (runtime == MainActivity.runtime) MainActivity.requestVideo(id, config);
        });
  }

  public void startAudio(long id) {
    Runtime runtime = owner.get();
    MainActivity.main.post(
        () -> {
          if (runtime == MainActivity.runtime) MainActivity.requestAudio(id);
        });
  }

  public void control(long id, String command, long layer, long value) {
    CaptureService.control(owner.get(), id, command, value);
  }

  public void stop(long id) {
    Runtime runtime = owner.get();
    MainActivity.main.post(() -> CaptureService.stopCapture(runtime, id));
  }
}
