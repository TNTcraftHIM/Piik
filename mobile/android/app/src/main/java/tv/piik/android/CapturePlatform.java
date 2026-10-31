package tv.piik.android;

import android.app.Activity;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.SurfaceTexture;
import android.hardware.display.*;
import android.media.*;
import android.media.projection.*;
import android.os.*;
import android.util.DisplayMetrics;
import android.view.*;

/** OS permission and callback facts for one Rust-owned Capture. No codec or media queue. */
public final class CapturePlatform implements AutoCloseable {
  private final Context context;
  private final SurfaceTexture texture = new SurfaceTexture(false);
  private final Surface surface = new Surface(texture);
  private MediaProjection projection;
  private VirtualDisplay display;
  private boolean closed, frame, audioRequested, audioDenied, foreground;
  private int width, height, density;
  private String error;
  private AudioRecord audio;
  private AppRuntimeService service;
  private java.lang.ref.WeakReference<MainActivity> permissionActivity;
  private final DisplayManager.DisplayListener resize = new DisplayManager.DisplayListener() {
    public void onDisplayAdded(int id) {}
    public void onDisplayRemoved(int id) {}
    public void onDisplayChanged(int id) { if (Build.VERSION.SDK_INT < 34) screenSize(); }
  };

  public CapturePlatform(Context context, boolean audioRequested) {
    this.context = context.getApplicationContext();
    this.audioRequested = audioRequested;
    screenSize();
    texture.setOnFrameAvailableListener(ignored -> {
      synchronized (this) { if (!closed) { frame = true; notifyAll(); } }
    }, AppRuntimeService.main);
    AppRuntimeService.main.post(() -> {
      synchronized (this) {
        if (closed) return;
        service = AppRuntimeService.instance;
        if (service == null) { fail("App runtime stopped"); return; }
        service.captureRequests.add(this);
        service.notifyActivity();
      }
    });
  }
  public SurfaceTexture texture() { return texture; }
  public synchronized boolean isClosed() { return closed; }
  synchronized boolean needsAudioPermission() {
    return audioRequested && !audioDenied && context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED;
  }
  synchronized void audioPermission(boolean granted) { audioDenied = !granted; notifyAll(); }
  synchronized void presented(MainActivity activity) { permissionActivity = new java.lang.ref.WeakReference<>(activity); }
  void grant(int result, Intent data) {
    synchronized (this) { permissionActivity = null; }
    if (result != Activity.RESULT_OK || data == null) { close(); return; }
    synchronized (this) {
      if (closed) return;
      try {
        if (service == null || AppRuntimeService.instance != service) throw new IllegalStateException("App runtime stopped");
        service.projections++;
        foreground = true;
        service.foreground();
        projection = context.getSystemService(MediaProjectionManager.class).getMediaProjection(result, data);
        projection.registerCallback(new MediaProjection.Callback() {
          @Override public void onStop() { close(); }
          @Override public void onCapturedContentResize(int w, int h) { size(w, h); }
        }, AppRuntimeService.main);
        notifyAll();
      } catch (RuntimeException failure) { fail(failure.toString()); }
    }
  }
  private void screenSize() {
    DisplayMetrics metrics = new DisplayMetrics();
    context.getSystemService(WindowManager.class).getDefaultDisplay().getRealMetrics(metrics);
    synchronized (this) { density = metrics.densityDpi; }
    size(metrics.widthPixels, metrics.heightPixels);
  }
  private synchronized void size(int w, int h) {
    if (closed || w <= 0 || h <= 0 || (width == w && height == h)) return;
    width = w; height = h;
    texture.setDefaultBufferSize(w, h);
    if (display != null) display.resize(w, h, density);
  }
  /** Called once on the source worker; the native stop handle wakes this wait. */
  public synchronized void start() throws InterruptedException {
    while (!closed && projection == null) wait();
    check();
    if (closed) return;
    display = projection.createVirtualDisplay("Piik", width, height, density,
        DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, surface, null, AppRuntimeService.main);
    if (display == null) throw new IllegalStateException("VirtualDisplay unavailable");
    context.getSystemService(DisplayManager.class).registerDisplayListener(resize, AppRuntimeService.main);
  }
  /** One coalesced OS notification; Rust owns the latest immutable image. */
  public synchronized long nextFrame() throws InterruptedException {
    while (!closed && !frame) wait();
    check();
    if (closed) return 0;
    frame = false;
    return ((long) width << 32) | (height & 0xffffffffL);
  }
  /** AudioRecord is constructed here because PlaybackCaptureConfiguration is Java-only.
   * Rust owns reads, timestamps, PCM framing and the audio worker lifetime. */
  public synchronized AudioRecord audio() throws InterruptedException {
    while (!closed && !audioDenied && (projection == null || needsAudioPermission())) wait();
    check();
    if (closed) throw new IllegalStateException("capture stopped");
    if (audioDenied) throw new IllegalStateException("audio_authorization_cancelled");
    if (audio != null) throw new IllegalStateException("source audio already opened");
    AudioFormat format = new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
        .setSampleRate(48000).setChannelMask(AudioFormat.CHANNEL_IN_STEREO).build();
    AudioPlaybackCaptureConfiguration capture = new AudioPlaybackCaptureConfiguration.Builder(projection)
        .addMatchingUsage(AudioAttributes.USAGE_MEDIA).addMatchingUsage(AudioAttributes.USAGE_GAME)
        .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN).build();
    int buffer = Math.max(960 * 2 * 4 * 2, AudioRecord.getMinBufferSize(48000, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_FLOAT));
    audio = new AudioRecord.Builder().setAudioFormat(format).setBufferSizeInBytes(buffer)
        .setAudioPlaybackCaptureConfig(capture).build();
    audio.startRecording();
    return audio;
  }
  public synchronized void stopAudio() {
    audioDenied = true; notifyAll();
    if (audio != null && audio.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) audio.stop();
  }
  public synchronized void releaseAudio() {
    stopAudio();
    if (audio != null) { audio.release(); audio = null; }
  }
  private synchronized void check() { if (error != null) throw new IllegalStateException(error); }
  private synchronized void fail(String message) { error = message; close(); }
  @Override public synchronized void close() {
    if (closed) return;
    closed = true; notifyAll();
    stopAudio();
    context.getSystemService(DisplayManager.class).unregisterDisplayListener(resize);
    if (display != null) { display.release(); display = null; }
    if (projection != null) { projection.stop(); projection = null; }
    AppRuntimeService.main.post(() -> {
      if (service != null) {
        service.captureRequests.remove(this);
        if (foreground) {
          service.projections--; foreground = false;
          if (AppRuntimeService.instance == service) service.foreground();
        }
        service = null;
      }
      MainActivity activity = permissionActivity == null ? null : permissionActivity.get();
      permissionActivity = null;
      if (activity != null) activity.captureClosed(this);
    });
  }
  /** Only after the native SurfaceTexture reader has detached and joined. */
  public synchronized void dispose() { close(); surface.release(); texture.release(); }
}
