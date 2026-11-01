package tv.piik.android;

import android.content.Context;
import android.content.pm.PackageManager;
import android.media.*;
import org.json.JSONArray;
import org.json.JSONObject;

/** One Rust audio worker owns this recorder, independently of MediaProjection. */
public final class MicrophonePlatform implements CaptureRequest {
  private final Context context;
  private final String deviceId;
  private boolean requested, approved, denied, closed, foreground;
  private String error;
  private AudioRecord record;
  private AppRuntimeService service;
  private java.lang.ref.WeakReference<MainActivity> permissionActivity;

  public MicrophonePlatform(Context context, String deviceId) {
    this.context = context.getApplicationContext();
    this.deviceId = deviceId;
  }
  public String devices() throws Exception {
    JSONArray result = new JSONArray();
    for (AudioDeviceInfo device : context.getSystemService(AudioManager.class).getDevices(AudioManager.GET_DEVICES_INPUTS)) {
      result.put(new JSONObject().put("id", Integer.toString(device.getId()))
          .put("label", device.getProductName().toString()));
    }
    return result.toString();
  }
  public synchronized boolean isClosed() { return closed; }
  public synchronized boolean needsAudioPermission() {
    return !denied && context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED;
  }
  public synchronized void audioPermission(boolean granted) { denied = !granted; notifyAll(); }
  public synchronized void presented(MainActivity activity) { permissionActivity = new java.lang.ref.WeakReference<>(activity); }

  // Only the existing visible media entry calls this, before it returns to Browser.
  synchronized void grant() {
    permissionActivity = null;
    if (closed) return;
    try {
      if (denied || needsAudioPermission()) throw new IllegalStateException("microphone_authorization_cancelled");
      if (service == null || AppRuntimeService.instance != service) throw new IllegalStateException("App runtime stopped");
      service.microphones++;
      foreground = true;
      service.foreground();
      approved = true;
    } catch (RuntimeException failure) {
      error = failure.toString();
      close();
    }
    notifyAll();
  }
  public synchronized AudioRecord audio() throws InterruptedException {
    if (!requested && !closed) {
      requested = true;
      AppRuntimeService.main.post(() -> {
        synchronized (this) {
          if (closed) return;
          service = AppRuntimeService.instance;
          if (service == null) { error = "App runtime stopped"; close(); return; }
          service.captureRequests.add(this);
          service.notifyActivity();
        }
      });
    }
    while (!closed && !approved) wait();
    if (error != null) throw new IllegalStateException(error);
    if (closed) throw new IllegalStateException("microphone stopped");
    if (record != null) throw new IllegalStateException("microphone already opened");
    AudioDeviceInfo selected = null;
    for (AudioDeviceInfo device : context.getSystemService(AudioManager.class).getDevices(AudioManager.GET_DEVICES_INPUTS)) {
      if (Integer.toString(device.getId()).equals(deviceId)) selected = device;
    }
    if (!deviceId.isEmpty() && selected == null) throw new IllegalArgumentException("The selected microphone is unavailable");
    AudioFormat format = new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
        .setSampleRate(48000).setChannelMask(AudioFormat.CHANNEL_IN_MONO).build();
    int minimum = AudioRecord.getMinBufferSize(48000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_FLOAT);
    record = new AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
        .setAudioFormat(format).setBufferSizeInBytes(Math.max(minimum, 960 * 4 * 2)).build();
    if (selected != null && !record.setPreferredDevice(selected)) throw new IllegalStateException("The selected microphone cannot be used");
    record.startRecording();
    if (record.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new IllegalStateException("The microphone did not start");
    AudioDeviceInfo routed = record.getRoutedDevice();
    if (selected != null && (routed == null || routed.getId() != selected.getId())) throw new IllegalStateException("The selected microphone is not routed");
    return record;
  }
  public void stopAudio() { close(); }
  public synchronized void releaseAudio() {
    try { close(); }
    finally {
      AudioRecord released = record;
      record = null;
      if (released != null) released.release();
    }
  }
  @Override public synchronized void close() {
    if (closed) return;
    closed = true;
    notifyAll();
    try {
      if (record != null && record.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) record.stop();
    } finally { AppRuntimeService.main.post(() -> {
      if (service != null) {
        service.captureRequests.remove(this);
        if (foreground) {
          service.microphones--; foreground = false;
          if (AppRuntimeService.instance == service) service.foreground();
        }
        service = null;
      }
      MainActivity activity = permissionActivity == null ? null : permissionActivity.get();
      permissionActivity = null;
      if (activity != null) activity.captureClosed(this);
    }); }
  }
}
