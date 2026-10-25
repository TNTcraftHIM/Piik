package tv.piik.android;

import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.hardware.display.*;
import android.media.*;
import android.media.projection.*;
import android.os.*;
import android.view.*;
import java.nio.*;
import java.util.*;
import org.json.*;

public final class CaptureService extends Service {
  static volatile CaptureService instance;

  static final class ProjectionOwner extends Binder {
    final tv.piik.bridge.Runtime runtime;

    ProjectionOwner(tv.piik.bridge.Runtime runtime) {
      this.runtime = runtime;
    }
  }

  static final String CHANNEL = "piik-sharing";
  HandlerThread thread;
  Handler handler;
  volatile MediaProjection projection;
  VirtualDisplay display;
  CaptureRenderer renderer;
  volatile Video video;
  volatile Video previousVideo;
  CapturedAudio audio;
  CapturedAudio previousAudio;
  volatile CapturedAudio microphone, previousMicrophone;
  Notification notice;
  int foregroundTypes;
  int captureWidth, captureHeight;
  volatile boolean retiring;
  volatile boolean stopRequested;
  boolean destroyed, cleanupDone, restoringVideo;

  final class Video {
    final long id;
    final tv.piik.bridge.Runtime runtime;

    Video(long id, tv.piik.bridge.Runtime runtime) {
      this.id = id;
      this.runtime = runtime;
    }

    MediaCodec codec;
    Surface surface;
    CaptureRenderer.Target target;
    int width, height, fps, bitrate, sourceWidth, sourceHeight;
    String configuration;
    byte[] config;
    long base = -1, last = -1;
    boolean ready, proven, released;
    String actualCodec, profile = "";
    List<EncoderCatalog.Entry> candidates;
    int candidateIndex;
    long deadline;
    Runnable timeout;
    Video replaced;
  }

  @Override
  public void onCreate() {
    super.onCreate();
    thread = new HandlerThread("Piik capture");
    thread.start();
    handler = new Handler(thread.getLooper());
    instance = this;
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    IBinder token =
        intent == null || intent.getExtras() == null ? null : intent.getExtras().getBinder("owner");
    final var runtime = token instanceof ProjectionOwner ? ((ProjectionOwner) token).runtime : null;
    android.util.Log.d(
        "PiikCapture",
        "projection service received; localOwner="
            + (token instanceof ProjectionOwner)
            + ", current="
            + (runtime == AppRuntimeService.runtime()));
    if (runtime == null || runtime != AppRuntimeService.runtime()) {
      if (projection == null) stopSelfResult(startId);
      return START_NOT_STICKY;
    }
    if (intent != null && (retiring || stopRequested)) {
      fail(runtime, intent.getLongExtra("id", 0));
      stopSelf();
      return START_NOT_STICKY;
    }
    if (intent == null
        || runtime == null
        || !runtime.captureCurrent(intent.getLongExtra("id", 0))) {
      stopSelf();
      return START_NOT_STICKY;
    }
    NotificationManager notifications = getSystemService(NotificationManager.class);
    notifications.createNotificationChannel(
        new NotificationChannel(
            CHANNEL, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW));
    PendingIntent open =
        PendingIntent.getActivity(
            this,
            0,
            new Intent(this, MainActivity.class),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    notice =
        new Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(getString(R.string.notification_body))
            .setContentIntent(open)
            .setOngoing(true)
            .build();
    startForeground(1, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
    foregroundTypes = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
    Intent consent = intent.getParcelableExtra("data");
    int result = intent.getIntExtra("result", 0);
    long id = intent.getLongExtra("id", 0);
    String config = intent.getStringExtra("config");
    handler.post(
        () -> {
          if (retiring || runtime == null || !runtime.captureCurrent(id)) {
            fail(runtime, id);
            finishProjection();
            return;
          }
          try {
            projection =
                getSystemService(MediaProjectionManager.class).getMediaProjection(result, consent);
            projection.registerCallback(
                new MediaProjection.Callback() {
                  @Override
                  public void onCapturedContentResize(int width, int height) {
                    captureWidth = width;
                    captureHeight = height;
                    resizeVideo();
                  }

                  @Override
                  public void onStop() {
                    finishProjection();
                  }
                },
                handler);
            beginVideo(runtime, id, config);
          } catch (Exception error) {
            fail(runtime, id);
            finishProjection();
          }
        });
    return START_NOT_STICKY;
  }

  static boolean replaceVideo(tv.piik.bridge.Runtime owner, long id, String config) {
    CaptureService s = instance;
    if (s == null
        || s.projection == null
        || s.stopRequested
        || s.video == null
        || s.video.runtime != owner) return false;
    s.handler.post(() -> s.beginVideo(owner, id, config));
    return true;
  }

  void beginVideo(tv.piik.bridge.Runtime runtime, long id, String json) {
    if (runtime == null || runtime != AppRuntimeService.runtime() || !runtime.captureCurrent(id))
      return;
    if (retiring || stopRequested || projection == null) {
      fail(runtime, id);
      return;
    }
    if (previousVideo != null || restoringVideo) {
      fail(runtime, id);
      return;
    }
    beginVideo(
        runtime,
        id,
        json,
        EncoderCatalog.candidates(codecRequested(json)),
        0,
        SystemClock.uptimeMillis() + 5000);
  }

  static String codecRequested(String json) {
    try {
      return new JSONObject(json).getString("codec");
    } catch (Exception error) {
      return "";
    }
  }

  void beginVideo(
      tv.piik.bridge.Runtime runtime,
      long id,
      String json,
      List<EncoderCatalog.Entry> candidates,
      int index,
      long deadline) {
    if (runtime != AppRuntimeService.runtime()
        || !runtime.captureCurrent(id)
        || retiring
        || stopRequested
        || projection == null) return;
    if (index >= candidates.size() || SystemClock.uptimeMillis() >= deadline) {
      // A rotation reuses the running stream identity; restored old capture stays valid.
      if (video != null && video.id == id && video.runtime == runtime) return;
      fail(runtime, id);
      if (video == null) finishProjection();
      return;
    }
    Video next = new Video(id, runtime);
    next.candidates = candidates;
    next.candidateIndex = index;
    next.deadline = deadline;
    next.configuration = json;
    Video old = video;
    next.replaced = old;
    try {
      JSONObject options = new JSONObject(json);
      if (captureWidth <= 0 || captureHeight <= 0) updateCaptureSize();
      next.sourceWidth = captureWidth;
      next.sourceHeight = captureHeight;
      double scale =
          Math.min(
              1.0,
              Math.min(
                  options.getDouble("width") / captureWidth,
                  options.getDouble("height") / captureHeight));
      next.width = Math.max(2, ((int) (captureWidth * scale)) & ~1);
      next.height = Math.max(2, ((int) (captureHeight * scale)) & ~1);
      next.fps = options.getInt("fps");
      EncoderCatalog.Entry selected = candidates.get(index);
      next.actualCodec = selected.codec;
      boolean h264 = selected.codec.equals("h264");
      next.codec = MediaCodec.createByCodecName(selected.name);
      MediaCodecInfo.CodecCapabilities capabilities =
          next.codec
              .getCodecInfo()
              .getCapabilitiesForType(h264 ? "video/avc" : "video/x-vnd.on2.vp8");
      MediaCodecInfo.VideoCapabilities supported = capabilities.getVideoCapabilities();
      next.width -= next.width % Math.max(2, supported.getWidthAlignment());
      next.height -= next.height % Math.max(2, supported.getHeightAlignment());
      MediaFormat format =
          MediaFormat.createVideoFormat(
              h264 ? "video/avc" : "video/x-vnd.on2.vp8", next.width, next.height);
      format.setInteger(
          MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
      next.bitrate = options.getInt("bitrate");
      format.setInteger(MediaFormat.KEY_BIT_RATE, next.bitrate);
      // CBR avoids Android's VBR quality floor overriding transport bitrate budgets.
      if (capabilities.getEncoderCapabilities()
          .isBitrateModeSupported(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR))
        format.setInteger(
            MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR);
      format.setInteger(MediaFormat.KEY_FRAME_RATE, next.fps);
      format.setFloat(MediaFormat.KEY_MAX_FPS_TO_ENCODER, next.fps);
      format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
      if (h264)
        format.setInteger(
            MediaFormat.KEY_PROFILE,
            MediaCodecInfo.CodecProfileLevel.AVCProfileConstrainedBaseline);
      next.codec.setCallback(
          new MediaCodec.Callback() {
            @Override
            public void onInputBufferAvailable(MediaCodec codec, int index) {}

            @Override
            public void onOutputBufferAvailable(
                MediaCodec codec, int index, MediaCodec.BufferInfo info) {
              try {
                if (next.released || (video != next && previousVideo != next)) return;
                ByteBuffer buffer = codec.getOutputBuffer(index);
                if (buffer == null || info.size == 0) return;
                buffer.position(info.offset);
                buffer.limit(info.offset + info.size);
                byte[] bytes = new byte[info.size];
                buffer.get(bytes);
                if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                  next.config = bytes;
                  return;
                }
                if (!next.ready) return;
                long pts = info.presentationTimeUs;
                if (next.base < 0) next.base = pts;
                pts -= next.base;
                if (pts <= next.last) return;
                next.last = pts;
                boolean key = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
                if (h264 && key && next.config != null) {
                  byte[] combined = new byte[next.config.length + bytes.length];
                  System.arraycopy(next.config, 0, combined, 0, next.config.length);
                  System.arraycopy(bytes, 0, combined, next.config.length, bytes.length);
                  bytes = combined;
                }
                boolean firstFrame = !next.proven;
                if (firstFrame) {
                  if (SystemClock.uptimeMillis() >= next.deadline) {
                    retryVideo(next);
                    return;
                  }
                  if (!key) return;
                  if (!runtime.videoReady(
                      id, next.actualCodec, next.width, next.height, next.profile)) {
                    retryVideo(next);
                    return;
                  }
                  next.proven = true;
                  AppRuntimeService.prepared(runtime, id);
                  handler.removeCallbacks(next.timeout);
                  if (next.replaced != null && next.replaced.id == id) {
                    retireVideo(next.replaced);
                    next.replaced = null;
                  }
                  JSONObject locked = new JSONObject(next.configuration);
                  locked.put("codec", next.actualCodec);
                  next.configuration = locked.toString();
                }
                runtime.video(id, bytes, pts, 1000000 / next.fps, key);
                if (firstFrame) handler.post(CaptureService.this::resizeVideo);
              } catch (Exception error) {
                retryVideo(next);
              } finally {
                try {
                  codec.releaseOutputBuffer(index, false);
                } catch (Exception ignored) {
                }
              }
            }

            @Override
            public void onError(MediaCodec codec, MediaCodec.CodecException error) {
              if (next.released || (video != next && previousVideo != next)) return;
              android.util.Log.w("PiikCapture", "encoder failed", error);
              retryVideo(next);
            }

            @Override
            public void onOutputFormatChanged(MediaCodec codec, MediaFormat output) {
              if (next.released || (video != next && previousVideo != next)) return;
              try {
                if (!h264) {
                  next.profile = "";
                  next.ready = true;
                  return;
                }
                ByteBuffer a = output.getByteBuffer("csd-0"), b = output.getByteBuffer("csd-1");
                byte[] sps = copy(a), pps = copy(b);
                next.config = new byte[sps.length + pps.length];
                System.arraycopy(sps, 0, next.config, 0, sps.length);
                System.arraycopy(pps, 0, next.config, sps.length, pps.length);
                String profile = null;
                for (int i = 0; i + 3 < sps.length; i++)
                  if ((sps[i] & 31) == 7) {
                    profile =
                        String.format(
                            java.util.Locale.ROOT,
                            "%02x%02x%02x",
                            sps[i + 1] & 255,
                            sps[i + 2] & 255,
                            sps[i + 3] & 255);
                    break;
                  }
                if (profile == null) throw new Exception("AVC configuration missing");
                next.profile = profile;
                next.ready = true;
              } catch (Exception error) {
                retryVideo(next);
              }
            }
          },
          handler);
      next.codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
      next.surface = next.codec.createInputSurface();
      next.codec.start();
      if (!runtime.captureCurrent(id)) throw new IllegalStateException("capture retired");
      // The Go stream owner closes old on commit or next on rollback.
      video = next;
      next.timeout =
          () -> {
            if (!next.proven && video == next) retryVideo(next);
          };
      // Consent has completed. Share one finite first-frame budget across encoders;
      // a silent candidate yields to another, never to an idle watchdog.
      handler.postAtTime(
          next.timeout,
          EncoderCatalog.attemptDeadline(
              SystemClock.uptimeMillis(), deadline, index + 1 < candidates.size()));
      if (old != null && old.id == id) {
        // Display rotation changes the physical encoder, not the Go stream clock.
        next.base = old.base;
        next.last = old.last;
      } else previousVideo = old;
      if (renderer == null) renderer = new CaptureRenderer(handler,
          error -> {
            android.util.Log.w("PiikCapture", "GPU capture initialization failed", error);
            fail(runtime, id);
            finishProjection();
          });
      next.target = new CaptureRenderer.Target(next.surface, next.width, next.height,
          next.sourceWidth, next.sourceHeight,
          error -> {
            android.util.Log.w("PiikCapture", "GPU capture failed", error);
            if (video == next) retryVideo(next);
          });
      bindVideo(next, () -> {});
    } catch (Exception error) {
      android.util.Log.w("PiikCapture", "video capture failed", error);
      retryVideo(next);
    }
  }

  void bindVideo(Video value, Runnable bound) {
    renderer.select(value.target,
        input -> {
          if (retiring || stopRequested || video != value || value.released) return;
          try {
            int density = getResources().getDisplayMetrics().densityDpi;
            if (display == null)
              display = projection.createVirtualDisplay(
                  "Piik", value.width, value.height, density,
                  DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, input, null, handler);
            else display.resize(value.width, value.height, density);
            if (display == null) throw new IllegalStateException("Could not create captured display");
            bound.run();
          } catch (RuntimeException error) {
            fail(value.runtime, value.id);
            finishProjection();
          }
        });
  }

  void retryVideo(Video failed) {
    if (failed.released) return;
    if (failed.timeout != null) handler.removeCallbacks(failed.timeout);
    if (failed.proven) {
      fail(failed.runtime, failed.id);
      return;
    }
    Video old = failed.replaced;
    restoringVideo = true;
    releaseVideo(failed,
        () -> {
          if (retiring || stopRequested) {
            retireVideo(old);
            return;
          }
          if (video == failed) video = old;
          if (previousVideo == old) previousVideo = null;
          Runnable retry = () -> {
            restoringVideo = false;
            beginVideo(failed.runtime, failed.id, failed.configuration, failed.candidates,
                failed.candidateIndex + 1, failed.deadline);
          };
          if (old == null) retry.run();
          else bindVideo(old,
              () -> {
                control(old.runtime, old.id, "keyframe", 0);
                retry.run();
              });
        });
  }

  void updateCaptureSize() {
    android.graphics.Point size = new android.graphics.Point();
    getSystemService(WindowManager.class).getDefaultDisplay().getRealSize(size);
    captureWidth = size.x;
    captureHeight = size.y;
  }

  void resizeVideo() {
    if (video == null || !video.proven || previousVideo != null || restoringVideo
        || retiring || stopRequested)
      return;
    if (video.sourceWidth != captureWidth || video.sourceHeight != captureHeight)
      beginVideo(video.runtime, video.id, video.configuration);
  }

  @Override
  public void onConfigurationChanged(android.content.res.Configuration configuration) {
    super.onConfigurationChanged(configuration);
    handler.post(
        () -> {
          updateCaptureSize();
          resizeVideo();
        });
  }

  static byte[] copy(ByteBuffer source) {
    if (source == null) return new byte[0];
    ByteBuffer data = source.duplicate();
    byte[] result = new byte[data.remaining()];
    data.get(result);
    return result;
  }

  static void control(tv.piik.bridge.Runtime owner, long id, String command, long value) {
    CaptureService s = instance;
    if (s != null)
      s.handler.post(
          () -> {
            Video current = s.video;
            if (current == null || current.id != id || current.runtime != owner) return;
            if (command.equals("bitrate") && current.bitrate == value) return;
            try {
              Bundle params = new Bundle();
              if (command.equals("keyframe"))
                params.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
              else if (command.equals("bitrate"))
                params.putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, (int) value);
              else return;
              current.codec.setParameters(params);
              if (command.equals("bitrate")) current.bitrate = (int) value;
              if (command.equals("keyframe")) s.renderer.refresh(current.target);
            } catch (Exception error) {
              android.util.Log.w("PiikCapture", "encoder control failed", error);
              s.fail(current.runtime, id);
            }
          });
  }

  static void startAudio(tv.piik.bridge.Runtime owner, long id) {
    CaptureService s = instance;
    if (s == null) {
      if (owner != null) owner.captureEnded(id);
      return;
    }
    s.handler.post(() -> s.beginAudio(owner, id));
  }

  void beginAudio(tv.piik.bridge.Runtime runtime, long id) {
    if (runtime == null || runtime != AppRuntimeService.runtime() || !runtime.captureCurrent(id))
      return;
    if (retiring || stopRequested) {
      fail(runtime, id);
      return;
    }
    if (previousAudio != null) {
      fail(runtime, id);
      return;
    }
    CapturedAudio next = new CapturedAudio(id, runtime);
    CapturedAudio old = audio;
    try {
      if (projection == null
          || checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
              != PackageManager.PERMISSION_GRANTED) {
        fail(runtime, id);
        return;
      }
      AudioPlaybackCaptureConfiguration config =
          new AudioPlaybackCaptureConfiguration.Builder(projection)
              .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
              .addMatchingUsage(AudioAttributes.USAGE_GAME)
              .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
              .excludeUid(android.os.Process.myUid())
              .build();
      AudioFormat format =
          new AudioFormat.Builder()
              .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
              .setSampleRate(48000)
              .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
              .build();
      int minimum =
          AudioRecord.getMinBufferSize(
              48000, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT);
      next.recorder =
          new AudioRecord.Builder()
              .setAudioFormat(format)
              .setBufferSizeInBytes(Math.max(minimum, 3840 * 4))
              .setAudioPlaybackCaptureConfig(config)
              .build();
      next.recorder.startRecording();
      if (next.recorder.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING)
        throw new IllegalStateException("Playback audio did not start");
      if (!runtime.captureCurrent(id)) throw new IllegalStateException("capture retired");
      audio = next;
      previousAudio = old;
      next.start(2);
    } catch (Exception error) {
      android.util.Log.w("PiikCapture", "playback audio capture failed", error);
      if (audio == next) {
        audio = old;
        previousAudio = null;
      }
      CapturedAudio.close(next);
    }
  }

  static void startMicrophone(tv.piik.bridge.Runtime owner, long id, String device) {
    CaptureService service = instance;
    if (service == null) {
      owner.captureEnded(id);
      return;
    }
    service.handler.post(
        () -> {
          if (owner != AppRuntimeService.runtime() || !owner.captureCurrent(id)) return;
          if (service.retiring
              || service.stopRequested
              || service.projection == null
              || service.previousMicrophone != null) {
            service.fail(owner, id);
            return;
          }
          CapturedAudio next = new CapturedAudio(id, owner);
          service.previousMicrophone = service.microphone;
          service.microphone = next;
          MainActivity.main.post(
              () -> {
                if (owner != AppRuntimeService.runtime()
                    || !owner.captureCurrent(id)
                    || service.microphone != next) {
                  service.handler.post(() -> service.discardMicrophone(next));
                  return;
                }
                try {
                  MainActivity activity = MainActivity.current;
                  if (service.previousMicrophone == null && (activity == null || !activity.visible))
                    throw new IllegalStateException("Open Piik before starting commentary");
                  service.updateMicrophoneForeground();
                  service.handler.post(() -> service.beginMicrophone(next, device));
                } catch (RuntimeException error) {
                  service.handler.post(() -> service.discardMicrophone(next));
                }
              });
        });
  }

  void beginMicrophone(CapturedAudio next, String deviceID) {
    if (microphone != next
        || next.stopped
        || next.runtime != AppRuntimeService.runtime()
        || !next.runtime.captureCurrent(next.id)) return;
    try {
      AudioDeviceInfo selected = MicrophoneDevices.selected(this, deviceID);
      AudioFormat format =
          new AudioFormat.Builder()
              .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
              .setSampleRate(48000)
              .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
              .build();
      int minimum =
          AudioRecord.getMinBufferSize(
              48000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
      next.recorder =
          new AudioRecord.Builder()
              // Commentary is speech; let the platform apply its available echo processing.
              .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
              .setAudioFormat(format)
              .setBufferSizeInBytes(Math.max(minimum, 1920 * 4))
              .build();
      if (selected != null && !next.recorder.setPreferredDevice(selected))
        throw new IllegalStateException("The selected microphone cannot be used");
      next.recorder.startRecording();
      if (next.recorder.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING)
        throw new IllegalStateException("The microphone did not start");
      AudioDeviceInfo routed = next.recorder.getRoutedDevice();
      if (selected != null && (routed == null || selected.getId() != routed.getId()))
        throw new IllegalStateException("The selected microphone is not routed");
      if (!next.runtime.captureCurrent(next.id))
        throw new IllegalStateException("Microphone retired");
      next.start(1);
    } catch (Exception error) {
      android.util.Log.w("PiikCapture", "commentary capture failed", error);
      discardMicrophone(next);
    }
  }

  void discardMicrophone(CapturedAudio next) {
    if (microphone == next) {
      microphone = previousMicrophone;
      previousMicrophone = null;
    }
    CapturedAudio.close(next);
    refreshMicrophoneForeground();
  }

  void updateMicrophoneForeground() {
    if (projection == null || retiring || stopRequested)
      throw new IllegalStateException("Projection retired");
    int desired = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
    if (Build.VERSION.SDK_INT >= 30 && (microphone != null || previousMicrophone != null))
      desired |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
    if (foregroundTypes != desired) {
      startForeground(1, notice, desired);
      foregroundTypes = desired;
    }
  }

  void refreshMicrophoneForeground() {
    MainActivity.main.post(
        () -> {
          if (instance != this || projection == null || retiring || stopRequested) return;
          try {
            updateMicrophoneForeground();
          } catch (RuntimeException error) {
            android.util.Log.w("PiikCapture", "capture foreground types failed", error);
            handler.post(this::finishProjection);
          }
        });
  }

  static void stopCapture(tv.piik.bridge.Runtime owner, long id) {
    CaptureService s = instance;
    if (s != null) {
      if (s.video != null
          && s.video.runtime == owner
          && s.video.id == id
          && s.previousVideo == null) s.stopRequested = true;
      s.handler.post(
          () -> {
            if (s.previousMicrophone != null
                && s.previousMicrophone.runtime == owner
                && s.previousMicrophone.id == id) {
              CapturedAudio committed = s.previousMicrophone;
              s.previousMicrophone = null;
              CapturedAudio.close(committed);
              s.refreshMicrophoneForeground();
            }
            if (s.microphone != null && s.microphone.runtime == owner && s.microphone.id == id) {
              CapturedAudio retired = s.microphone;
              s.microphone = s.previousMicrophone;
              s.previousMicrophone = null;
              CapturedAudio.close(retired);
              s.refreshMicrophoneForeground();
            }
            if (s.previousAudio != null
                && s.previousAudio.runtime == owner
                && s.previousAudio.id == id) {
              CapturedAudio committed = s.previousAudio;
              s.previousAudio = null;
              CapturedAudio.close(committed);
            }
            if (s.audio != null && s.audio.runtime == owner && s.audio.id == id) {
              CapturedAudio old = s.audio;
              s.audio = s.previousAudio;
              s.previousAudio = null;
              CapturedAudio.close(old);
            }
            if (s.previousVideo != null
                && s.previousVideo.runtime == owner
                && s.previousVideo.id == id) {
              Video committed = s.previousVideo;
              s.previousVideo = null;
              if (s.video != null && s.video.replaced == committed) s.video.replaced = null;
              s.retireVideo(committed);
              s.resizeVideo();
            }
            if (s.video != null && s.video.runtime == owner && s.video.id == id) {
              if (s.previousVideo == null) {
                s.finishProjection();
                return;
              }
              Video discarded = s.video;
              try {
                Video restored = s.previousVideo;
                s.video = restored;
                s.previousVideo = null;
                // Output queued while preparing next was discarded. Resume
                // independently of those missing reference frames.
                s.bindVideo(restored,
                    () -> {
                      control(restored.runtime, restored.id, "keyframe", 0);
                      s.releaseVideo(discarded);
                      s.resizeVideo();
                    });
              } catch (Exception error) {
                s.finishProjection();
              }
            }
          });
    }
  }

  void fail(tv.piik.bridge.Runtime runtime, long id) {
    if (runtime != null) {
      runtime.captureEnded(id);
      AppRuntimeService.failed(runtime, id);
    }
  }

  void releaseVideo(Video value) {
    releaseVideo(value, () -> {});
  }

  void releaseVideo(Video value, Runnable released) {
    if (value == null || value.released) {
      released.run();
      return;
    }
    value.released = true;
    if (value.timeout != null) handler.removeCallbacks(value.timeout);
    // Retire its EGL window before stopping the codec or releasing its input Surface.
    if (value.target != null) renderer.release(value.target,
        () -> {
          releaseCodec(value);
          released.run();
        });
    else {
      releaseCodec(value);
      released.run();
    }
  }

  void releaseCodec(Video value) {
    try {
      value.codec.stop();
    } catch (Exception ignored) {
    }
    try {
      value.codec.release();
    } catch (Exception ignored) {
    }
    if (value.surface != null) value.surface.release();
  }

  // A retired target can retain an unfinished rotation of the same Go stream.
  // Rollback releases only the failed candidate; final retirement owns its chain.
  void retireVideo(Video value) {
    while (value != null) {
      Video previous = value.replaced;
      value.replaced = null;
      releaseVideo(value);
      value = previous;
    }
  }

  void finishProjection() {
    if (retiring) return;
    retiring = true;
    Video old = video;
    video = null;
    Video pendingOld = previousVideo;
    previousVideo = null;
    CapturedAudio oldAudio = audio;
    audio = null;
    CapturedAudio pendingOldAudio = previousAudio;
    previousAudio = null;
    CapturedAudio oldMicrophone = microphone;
    microphone = null;
    CapturedAudio oldPreviousMicrophone = previousMicrophone;
    previousMicrophone = null;
    if (display != null) {
      display.release();
      display = null;
    }
    // Unblock JNI output before waiting for the GL queue, including a pending swap.
    if (old != null) old.runtime.captureEnded(old.id);
    if (pendingOld != null) pendingOld.runtime.captureEnded(pendingOld.id);
    retireVideo(old);
    retireVideo(pendingOld);
    CapturedAudio.close(oldAudio);
    CapturedAudio.close(pendingOldAudio);
    CapturedAudio.close(oldMicrophone);
    CapturedAudio.close(oldPreviousMicrophone);
    if (projection != null) {
      MediaProjection oldProjection = projection;
      projection = null;
      oldProjection.stop();
    }
    stopForeground(STOP_FOREGROUND_REMOVE);
    Runnable closed = () -> {
      cleanupDone = true;
      stopSelf();
      if (destroyed) thread.quitSafely();
    };
    if (renderer != null) renderer.close(closed);
    else closed.run();
  }

  static void shutdown() {
    CaptureService s = instance;
    if (s != null) s.handler.post(s::finishProjection);
  }

  @Override
  public void onDestroy() {
    if (instance == this) instance = null;
    if (handler != null)
      handler.post(
          () -> {
            destroyed = true;
            finishProjection();
            if (cleanupDone) thread.quitSafely();
          });
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
