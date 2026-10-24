package tv.piik.android;

import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.hardware.display.*;
import android.media.*;
import android.media.projection.*;
import android.os.*;
import android.util.DisplayMetrics;
import android.view.*;
import java.nio.*;
import java.util.*;
import org.json.*;

public final class CaptureService extends Service {
  static volatile CaptureService instance;

  static final class ProjectionOwner extends Binder {
    final tv.piik.androidbridge.Runtime runtime;

    ProjectionOwner(tv.piik.androidbridge.Runtime runtime) {
      this.runtime = runtime;
    }
  }

  static final String CHANNEL = "piik-sharing";
  HandlerThread thread;
  Handler handler;
  volatile MediaProjection projection;
  VirtualDisplay display;
  volatile Video video;
  volatile Video previousVideo;
  Audio audio;
  Audio previousAudio;
  int captureWidth, captureHeight;
  volatile boolean retiring;
  volatile boolean stopRequested;

  final class Video {
    final long id;
    final tv.piik.androidbridge.Runtime runtime;

    Video(long id, tv.piik.androidbridge.Runtime runtime) {
      this.id = id;
      this.runtime = runtime;
    }

    MediaCodec codec;
    Surface surface;
    int width, height, fps, sourceWidth, sourceHeight;
    String configuration;
    byte[] config;
    long base = -1, last = -1;
    boolean ready;
  }

  final class Audio {
    final long id;
    final tv.piik.androidbridge.Runtime runtime;

    Audio(long id, tv.piik.androidbridge.Runtime runtime) {
      this.id = id;
      this.runtime = runtime;
    }

    AudioRecord recorder;
    volatile boolean stopped;
    Thread reader;
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
            + (runtime == MainActivity.runtime));
    if (runtime == null || runtime != MainActivity.runtime) {
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
    Notification notice =
        new Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(getString(R.string.notification_body))
            .setContentIntent(open)
            .setOngoing(true)
            .build();
    startForeground(1, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
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
            beginVideo(id, config);
          } catch (Exception error) {
            fail(runtime, id);
            finishProjection();
          }
        });
    return START_NOT_STICKY;
  }

  static boolean replaceVideo(tv.piik.androidbridge.Runtime owner, long id, String config) {
    CaptureService s = instance;
    if (s == null
        || s.projection == null
        || s.stopRequested
        || s.video == null
        || s.video.runtime != owner) return false;
    s.handler.post(() -> s.beginVideo(id, config));
    return true;
  }

  void beginVideo(long id, String json) {
    final var runtime = MainActivity.runtime;
    if (runtime == null || !runtime.captureCurrent(id)) return;
    if (retiring || stopRequested || projection == null) {
      fail(runtime, id);
      return;
    }
    if (previousVideo != null) {
      fail(runtime, id);
      return;
    }
    Video next = new Video(id, runtime);
    next.configuration = json;
    Video old = video;
    try {
      JSONObject options = new JSONObject(json);
      DisplayMetrics metrics = getResources().getDisplayMetrics();
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
      boolean h264 = options.getString("codec").equals("h264");
      next.codec = MediaCodec.createByCodecName(MainActivity.encoderName);
      MediaCodecInfo.VideoCapabilities supported =
          next.codec
              .getCodecInfo()
              .getCapabilitiesForType(h264 ? "video/avc" : "video/x-vnd.on2.vp8")
              .getVideoCapabilities();
      next.width -= next.width % Math.max(2, supported.getWidthAlignment());
      next.height -= next.height % Math.max(2, supported.getHeightAlignment());
      MediaFormat format =
          MediaFormat.createVideoFormat(
              h264 ? "video/avc" : "video/x-vnd.on2.vp8", next.width, next.height);
      format.setInteger(
          MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
      format.setInteger(MediaFormat.KEY_BIT_RATE, options.getInt("bitrate"));
      format.setInteger(MediaFormat.KEY_FRAME_RATE, next.fps);
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
                if (video != next && previousVideo != next) return;
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
                if (key && next.config != null) {
                  byte[] combined = new byte[next.config.length + bytes.length];
                  System.arraycopy(next.config, 0, combined, 0, next.config.length);
                  System.arraycopy(bytes, 0, combined, next.config.length, bytes.length);
                  bytes = combined;
                }
                runtime.video(id, bytes, pts, 1000000 / next.fps, key);
              } catch (Exception error) {
                fail(runtime, id);
              } finally {
                try {
                  codec.releaseOutputBuffer(index, false);
                } catch (Exception ignored) {
                }
              }
            }

            @Override
            public void onError(MediaCodec codec, MediaCodec.CodecException error) {
              android.util.Log.w("PiikCapture", "encoder failed", error);
              fail(runtime, id);
            }

            @Override
            public void onOutputFormatChanged(MediaCodec codec, MediaFormat output) {
              if (video != next && previousVideo != next) return;
              try {
                if (!h264) {
                  runtime.videoReady(id, next.width, next.height, "");
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
                runtime.videoReady(id, next.width, next.height, profile);
                next.ready = true;
              } catch (Exception error) {
                fail(runtime, id);
              }
            }
          },
          handler);
      next.codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
      next.surface = next.codec.createInputSurface();
      next.codec.start();
      if (display == null)
        display =
            projection.createVirtualDisplay(
                "Piik",
                next.width,
                next.height,
                metrics.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                next.surface,
                null,
                handler);
      else {
        display.resize(next.width, next.height, metrics.densityDpi);
        display.setSurface(next.surface);
      }
      if (display == null) throw new IllegalStateException("Could not create captured display");
      if (!runtime.captureCurrent(id)) throw new IllegalStateException("capture retired");
      // The Go stream owner closes old on commit or next on rollback.
      video = next;
      if (old != null && old.id == id) {
        // Display rotation changes the physical encoder, not the Go stream clock.
        next.base = old.base;
        next.last = old.last;
        releaseVideo(old);
      } else previousVideo = old;
    } catch (Exception error) {
      android.util.Log.w("PiikCapture", "video capture failed", error);
      boolean restored = false;
      if (old != null && display != null) {
        try {
          display.resize(old.width, old.height, getResources().getDisplayMetrics().densityDpi);
          display.setSurface(old.surface);
          restored = true;
        } catch (Exception ignored) {
        }
      }
      releaseVideo(next);
      fail(runtime, id);
      if (!restored) finishProjection();
    }
  }

  void updateCaptureSize() {
    android.graphics.Point size = new android.graphics.Point();
    getSystemService(WindowManager.class).getDefaultDisplay().getRealSize(size);
    captureWidth = size.x;
    captureHeight = size.y;
  }

  void resizeVideo() {
    if (video == null || previousVideo != null || retiring || stopRequested) return;
    if (video.sourceWidth != captureWidth || video.sourceHeight != captureHeight)
      beginVideo(video.id, video.configuration);
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

  static void control(tv.piik.androidbridge.Runtime owner, long id, String command, long value) {
    CaptureService s = instance;
    if (s != null)
      s.handler.post(
          () -> {
            Video current = s.video;
            if (current == null || current.id != id || current.runtime != owner) return;
            try {
              Bundle params = new Bundle();
              if (command.equals("keyframe"))
                params.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
              else if (command.equals("bitrate"))
                params.putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, (int) value);
              else return;
              current.codec.setParameters(params);
            } catch (Exception error) {
              s.fail(current.runtime, id);
            }
          });
  }

  static void startAudio(tv.piik.androidbridge.Runtime owner, long id) {
    CaptureService s = instance;
    if (s == null) {
      if (owner != null) owner.captureEnded(id);
      return;
    }
    s.handler.post(
        () -> {
          if (owner == MainActivity.runtime) s.beginAudio(id);
        });
  }

  void beginAudio(long id) {
    final var runtime = MainActivity.runtime;
    if (runtime == null || !runtime.captureCurrent(id)) return;
    if (retiring || stopRequested) {
      fail(runtime, id);
      return;
    }
    if (previousAudio != null) {
      fail(runtime, id);
      return;
    }
    Audio next = new Audio(id, runtime);
    Audio old = audio;
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
      if (!runtime.captureCurrent(id)) throw new IllegalStateException("capture retired");
      audio = next;
      previousAudio = old;
      next.reader =
          new Thread(
              () -> {
                byte[] bytes = new byte[3840];
                try {
                  while (!next.stopped) {
                    int offset = 0;
                    while (offset < bytes.length && !next.stopped) {
                      int count =
                          next.recorder.read(
                              bytes, offset, bytes.length - offset, AudioRecord.READ_BLOCKING);
                      if (count <= 0) throw new Exception("AudioRecord stopped");
                      offset += count;
                    }
                    if (!next.stopped) runtime.audio(id, bytes);
                  }
                } catch (Exception error) {
                  if (!next.stopped) fail(runtime, id);
                }
              },
              "Piik source audio");
      next.reader.start();
      runtime.audioReady(id);
    } catch (Exception error) {
      android.util.Log.w("PiikCapture", "playback audio capture failed", error);
      if (audio == next) {
        audio = old;
        previousAudio = null;
      }
      releaseAudio(next);
      fail(runtime, id);
    }
  }

  static void stopCapture(tv.piik.androidbridge.Runtime owner, long id) {
    CaptureService s = instance;
    if (s != null) {
      if (s.video != null
          && s.video.runtime == owner
          && s.video.id == id
          && s.previousVideo == null) s.stopRequested = true;
      s.handler.post(
          () -> {
            if (s.previousAudio != null
                && s.previousAudio.runtime == owner
                && s.previousAudio.id == id) {
              Audio committed = s.previousAudio;
              s.previousAudio = null;
              s.releaseAudio(committed);
            }
            if (s.audio != null && s.audio.runtime == owner && s.audio.id == id) {
              Audio old = s.audio;
              s.audio = s.previousAudio;
              s.previousAudio = null;
              s.releaseAudio(old);
            }
            if (s.previousVideo != null
                && s.previousVideo.runtime == owner
                && s.previousVideo.id == id) {
              Video committed = s.previousVideo;
              s.previousVideo = null;
              s.releaseVideo(committed);
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
                s.display.resize(
                    restored.width,
                    restored.height,
                    s.getResources().getDisplayMetrics().densityDpi);
                s.display.setSurface(restored.surface);
                s.video = restored;
                s.previousVideo = null;
                // Output queued while preparing next was discarded. Resume
                // independently of those missing reference frames.
                control(restored.runtime, restored.id, "keyframe", 0);
                s.releaseVideo(discarded);
                s.resizeVideo();
              } catch (Exception error) {
                s.finishProjection();
              }
            }
          });
    }
  }

  void fail(tv.piik.androidbridge.Runtime runtime, long id) {
    if (runtime != null) runtime.captureEnded(id);
  }

  void releaseVideo(Video value) {
    if (value == null) return;
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

  void releaseAudio(Audio value) {
    if (value == null) return;
    value.stopped = true;
    try {
      value.recorder.stop();
    } catch (Exception ignored) {
    }
    if (value.reader != null) {
      try {
        value.reader.join(1000);
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
      }
    }
    try {
      value.recorder.release();
    } catch (Exception ignored) {
    }
  }

  void finishProjection() {
    if (retiring) return;
    retiring = true;
    Video old = video;
    video = null;
    Video pendingOld = previousVideo;
    previousVideo = null;
    Audio oldAudio = audio;
    audio = null;
    Audio pendingOldAudio = previousAudio;
    previousAudio = null;
    if (display != null) {
      display.release();
      display = null;
    }
    releaseVideo(old);
    releaseVideo(pendingOld);
    releaseAudio(oldAudio);
    releaseAudio(pendingOldAudio);
    if (projection != null) {
      MediaProjection oldProjection = projection;
      projection = null;
      oldProjection.stop();
    }
    if (old != null) old.runtime.captureEnded(old.id);
    if (pendingOld != null) pendingOld.runtime.captureEnded(pendingOld.id);
    if (oldAudio != null) oldAudio.runtime.captureEnded(oldAudio.id);
    if (pendingOldAudio != null) pendingOldAudio.runtime.captureEnded(pendingOldAudio.id);
    stopForeground(STOP_FOREGROUND_REMOVE);
    stopSelf();
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
            finishProjection();
            thread.quitSafely();
          });
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
