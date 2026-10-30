package tv.piik.android;

import android.content.Context;
import android.content.res.AssetManager;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.concurrent.CompletableFuture;

/** Bootstrap only; Rust owns rooms, site approval, launcher and networking. */
final class NativeRuntime implements AutoCloseable {
  static { System.loadLibrary("piik_channel_android"); }
  final CompletableFuture<String> stopped = new CompletableFuture<>();
  private long handle;
  private String entry;

  static NativeRuntime start(Context context) throws IOException {
    Context application = context.getApplicationContext();
    File frontend = new File(application.getCacheDir(), "channel-web");
    copyAssets(application.getAssets(), "web", frontend);
    NativeRuntime runtime = new NativeRuntime();
    runtime.handle = runtime.nativeStart(
        application,
        new File(application.getFilesDir(), "channel-app").getAbsolutePath(),
        application.getCacheDir().getAbsolutePath(),
        frontend.getAbsolutePath(),
        new File(application.getApplicationInfo().nativeLibraryDir, "libcloudflared.so").getAbsolutePath());
    runtime.entry = nativeEntryURL(runtime.handle);
    return runtime;
  }

  private static void copyAssets(AssetManager assets, String path, File target) throws IOException {
    String[] children = assets.list(path);
    if (children.length != 0) {
      Files.createDirectories(target.toPath());
      for (String child : children) copyAssets(assets, path + "/" + child, new File(target, child));
    } else {
      try (var input = assets.open(path)) {
        Files.copy(input, target.toPath(), StandardCopyOption.REPLACE_EXISTING);
      }
    }
  }

  String entryURL() { return entry; }

  // Called by the runtime thread, including failures before start returns.
  private void runtimeStopped(String reason) { stopped.complete(reason); }

  @Override public void close() {
    long retired = handle;
    handle = 0;
    if (retired != 0) nativeStop(retired);
  }

  private native long nativeStart(Context application, String data, String cache, String frontend, String helper);
  private static native String nativeEntryURL(long handle);
  private static native void nativeStop(long handle);
}
