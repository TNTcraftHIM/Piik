package tv.piik.android;

import java.lang.ref.WeakReference;
import tv.piik.bridge.Platform;
import tv.piik.bridge.Runtime;

// Each JNI adapter belongs to one Go runtime, even when stream IDs restart at one.
final class CapturePlatform implements Platform {
  final android.content.Context context;
  volatile WeakReference<Runtime> owner = new WeakReference<>(null);

  CapturePlatform(android.content.Context context) {
    this.context = context.getApplicationContext();
  }

  public String microphones() throws Exception {
    return MicrophoneDevices.list(context);
  }

  public void startMicrophone(long id, String device) {
    Runtime runtime = owner.get();
    MainActivity.main.post(
        () -> {
          AppRuntimeService.enqueue(runtime, id, "microphone", device);
        });
  }

  public void startVideo(long id, String config) {
    Runtime runtime = owner.get();
    MainActivity.main.post(
        () -> {
          AppRuntimeService.enqueue(runtime, id, "video", config);
        });
  }

  public void startAudio(long id) {
    Runtime runtime = owner.get();
    MainActivity.main.post(
        () -> {
          AppRuntimeService.enqueue(runtime, id, "audio", "");
        });
  }

  public void control(long id, String command, long layer, long value) {
    CaptureService.control(owner.get(), id, command, (int) layer, value);
  }

  public void stop(long id) {
    Runtime runtime = owner.get();
    MainActivity.main.post(
        () -> {
          AppRuntimeService.retire(runtime, id);
          CaptureService.stopCapture(runtime, id);
        });
  }

  public void preparationDone(long id) {
    Runtime runtime = owner.get();
    MainActivity.main.post(() -> AppRuntimeService.preparationDone(runtime, id));
  }

  // Site revocation is enforced by the shared control service; Android owns no page.
  public void siteAccessChanged() {}

  public void runtimeStopped(String reason) {
    Runtime runtime = owner.get();
    MainActivity.main.post(() -> AppRuntimeService.runtimeStopped(runtime, reason));
  }
}
