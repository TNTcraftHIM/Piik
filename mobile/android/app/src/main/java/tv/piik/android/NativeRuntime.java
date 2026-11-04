package tv.piik.android;

import android.content.Context;
import android.content.res.AssetManager;
import java.io.File;
import java.io.IOException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.concurrent.CompletableFuture;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Bootstrap only; Rust owns rooms, site approval, launcher and networking. */
final class NativeRuntime implements AutoCloseable {
  static { System.loadLibrary("piik_channel_android"); }
  final CompletableFuture<String> stopped = new CompletableFuture<>();
  private long handle;
  private String entry;

  static NativeRuntime start(Context context) throws IOException {
    Context application = context.getApplicationContext();
    File frontend = new File(application.getCacheDir(), "channel-web");
    extractFrontend(application.getAssets(), frontend);
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

  private static void extractFrontend(AssetManager assets, File target) throws IOException {
    var directory = target.toPath().toAbsolutePath().normalize();
    if (Files.exists(directory)) {
      Files.walkFileTree(directory, new SimpleFileVisitor<Path>() {
        @Override
        public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
          Files.delete(file);
          return FileVisitResult.CONTINUE;
        }

        @Override
        public FileVisitResult postVisitDirectory(Path folder, IOException error) throws IOException {
          if (error != null) throw error;
          Files.delete(folder);
          return FileVisitResult.CONTINUE;
        }
      });
    }
    Files.createDirectories(directory);
    try (var archive = new ZipInputStream(assets.open("web/frontend.zip"))) {
      ZipEntry entry;
      while ((entry = archive.getNextEntry()) != null) {
        var output = directory.resolve(entry.getName()).normalize();
        if (!output.startsWith(directory)) throw new IOException("Invalid frontend archive path");
        if (entry.isDirectory()) {
          Files.createDirectories(output);
        } else {
          Files.createDirectories(output.getParent());
          Files.copy(archive, output, StandardCopyOption.REPLACE_EXISTING);
        }
        archive.closeEntry();
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
