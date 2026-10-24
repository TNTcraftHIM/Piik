package tv.piik.android;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.projection.MediaProjectionConfig;
import android.media.projection.MediaProjectionManager;
import android.net.*;
import android.os.*;
import java.net.Inet4Address;
import java.util.ArrayDeque;
import java.util.concurrent.*;
import tv.piik.androidbridge.Androidbridge;
import tv.piik.androidbridge.Runtime;

// One user-started native companion owns the Go core and pending OS consent.
public final class AppRuntimeService extends Service {
  static volatile AppRuntimeService instance;
  static final Handler main = new Handler(Looper.getMainLooper());
  static final int PROJECTION = 10, AUDIO_PERMISSION = 12;
  final ExecutorService work = Executors.newSingleThreadExecutor();
  final ArrayDeque<MediaRequest> requests = new ArrayDeque<>();
  Runtime runtime;
  CompletableFuture<Runtime> startup;
  Throwable failure;
  MediaRequest active;

  static final class MediaRequest {
    final Runtime owner;
    final long id;
    final String kind, configuration;
    boolean awaitingResult;

    MediaRequest(Runtime owner, long id, String kind, String configuration) {
      this.owner = owner;
      this.id = id;
      this.kind = kind;
      this.configuration = configuration;
    }

    boolean current() {
      return owner == AppRuntimeService.runtime() && owner.captureCurrent(id);
    }
  }

  static Runtime runtime() {
    return instance == null ? null : instance.runtime;
  }

  @Override
  public void onCreate() {
    super.onCreate();
    instance = this;
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && "stop".equals(intent.getAction())) {
      stopSelf();
      return START_NOT_STICKY;
    }
    try {
      foreground();
    } catch (RuntimeException error) {
      failure = error;
      notifyActivity();
      stopSelf();
      return START_NOT_STICKY;
    }
    if (runtime != null || failure != null) notifyActivity();
    else if (startup == null) startRuntime();
    return START_NOT_STICKY;
  }

  void foreground() {
    NotificationManager notifications = getSystemService(NotificationManager.class);
    notifications.createNotificationChannel(
        new NotificationChannel(
            "piik-runtime",
            getString(R.string.runtime_channel),
            NotificationManager.IMPORTANCE_LOW));
    PendingIntent open =
        PendingIntent.getActivity(
            this,
            20,
            new Intent(this, MainActivity.class),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    PendingIntent stop =
        PendingIntent.getService(
            this,
            21,
            new Intent(this, AppRuntimeService.class).setAction("stop"),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    Notification notice =
        new Notification.Builder(this, "piik-runtime")
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .setContentTitle(getString(R.string.runtime_title))
            .setContentText(getString(R.string.runtime_body))
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(
                new Notification.Action.Builder(null, getString(R.string.runtime_open), open)
                    .build())
            .addAction(
                new Notification.Action.Builder(null, getString(R.string.runtime_stop), stop)
                    .build())
            .build();
    startForeground(
        3,
        notice,
        Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0);
  }

  void startRuntime() {
    CompletableFuture<Runtime> starting =
        CompletableFuture.supplyAsync(
            () -> {
              try {
                ConnectivityManager manager = getSystemService(ConnectivityManager.class);
                LinkProperties links = manager.getLinkProperties(manager.getActiveNetwork());
                String address = "";
                if (links != null)
                  for (LinkAddress link : links.getLinkAddresses())
                    if (link.getAddress() instanceof Inet4Address
                        && !link.getAddress().isLoopbackAddress()) {
                      address = link.getAddress().getHostAddress();
                      break;
                    }
                CapturePlatform platform = new CapturePlatform(getApplicationContext());
                Runtime started =
                    Androidbridge.start(
                        platform,
                        address,
                        EncoderCatalog.capabilities(),
                        getFilesDir().getAbsolutePath(),
                        getCacheDir().getAbsolutePath(),
                        new java.io.File(getApplicationInfo().nativeLibraryDir, "libcloudflared.so")
                            .getAbsolutePath(),
                        BuildConfig.EXTERNAL_BROWSER ? "piik://media" : "");
                platform.owner = new java.lang.ref.WeakReference<>(started);
                return started;
              } catch (Exception error) {
                throw new CompletionException(error);
              }
            },
            work);
    startup = starting;
    starting.whenComplete(
        (started, error) ->
            main.post(
                () -> {
                  if (instance != this || startup != starting) {
                    return;
                  }
                  startup = null;
                  runtime = started;
                  failure = error;
                  notifyActivity();
                }));
  }

  void notifyActivity() {
    MainActivity activity = MainActivity.current;
    if (activity != null && activity.visible) activity.runtimeAvailable(this);
  }

  static void enqueue(Runtime owner, long id, String kind, String configuration) {
    AppRuntimeService service = instance;
    if (service == null || owner == null || owner != service.runtime || !owner.captureCurrent(id))
      return;
    if (kind.equals("video") && CaptureService.replaceVideo(owner, id, configuration)) return;
    if (kind.equals("audio")
        && service.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED) {
      CaptureService.startAudio(owner, id);
      return;
    }
    service.requests.add(new MediaRequest(owner, id, kind, configuration));
    service.processRequests();
  }

  void processRequests() {
    if (active != null) return;
    requests.removeIf(request -> !request.current());
    MainActivity activity = MainActivity.current;
    if (activity == null
        || !activity.visible
        || (BuildConfig.EXTERNAL_BROWSER && !activity.mediaEntry())) return;
    MediaRequest next = requests.poll();
    if (next == null) {
      activity.mediaFinished();
      return;
    }
    active = next;
    activity.mediaStarted();
    activity.permissionOwner = this;
    activity.permissionRequest = next;
    if (next.kind.equals("video")) {
      try {
        MediaProjectionManager manager = activity.getSystemService(MediaProjectionManager.class);
        Intent consent =
            Build.VERSION.SDK_INT >= 34
                ? manager.createScreenCaptureIntent(
                    MediaProjectionConfig.createConfigForDefaultDisplay())
                : manager.createScreenCaptureIntent();
        next.awaitingResult = true;
        activity.startActivityForResult(consent, PROJECTION);
      } catch (RuntimeException error) {
        android.util.Log.w("PiikRuntime", "projection consent failed", error);
        complete(next, false);
      }
    } else if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
        != PackageManager.PERMISSION_GRANTED) {
      next.awaitingResult = true;
      activity.requestPermissions(
          new String[] {Manifest.permission.RECORD_AUDIO}, AUDIO_PERMISSION);
    } else audioPermissionResult(next);
  }

  void projectionResult(MainActivity activity, MediaRequest request, int result, Intent data) {
    if (instance != this || request == null || active != request || !request.kind.equals("video"))
      return;
    request.awaitingResult = false;
    if (result != Activity.RESULT_OK || data == null || !request.current()) {
      complete(request, false);
      return;
    }
    Intent capture =
        new Intent(this, CaptureService.class)
            .putExtra("result", result)
            .putExtra("data", data)
            .putExtra("id", request.id)
            .putExtra("config", request.configuration);
    Bundle ownership = new Bundle();
    ownership.putBinder("owner", new CaptureService.ProjectionOwner(request.owner));
    capture.putExtras(ownership);
    try {
      activity.startForegroundService(capture);
    } catch (RuntimeException error) {
      complete(request, false);
    }
    // Return only after the physical service has admitted or failed this request.
  }

  void audioPermissionResult(MediaRequest request) {
    if (instance != this || request == null || active != request || request.kind.equals("video"))
      return;
    request.awaitingResult = false;
    if (!request.current()
        || checkSelfPermission(Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
      complete(request, false);
    } else if (request.kind.equals("microphone")) {
      CaptureService.startMicrophone(request.owner, request.id, request.configuration);
    } else CaptureService.startAudio(request.owner, request.id);
  }

  static void prepared(Runtime owner, long id) {
    main.post(
        () -> {
          AppRuntimeService service = instance;
          if (service != null
              && service.active != null
              && service.active.owner == owner
              && service.active.id == id) service.complete(service.active, true);
        });
  }

  static void failed(Runtime owner, long id) {
    main.post(
        () -> {
          AppRuntimeService service = instance;
          if (service != null
              && service.active != null
              && service.active.owner == owner
              && service.active.id == id
              && !service.active.awaitingResult) service.complete(service.active, false);
        });
  }

  static void retire(Runtime owner, long id) {
    AppRuntimeService service = instance;
    if (service == null) return;
    service.requests.removeIf(request -> request.owner == owner && request.id == id);
    if (service.active != null
        && service.active.owner == owner
        && service.active.id == id
        && !service.active.awaitingResult) service.complete(service.active, false);
    // Keep an in-flight OS result bound to its original request until it returns.
  }

  void cancelPending() {
    for (MediaRequest request : requests) request.owner.captureEnded(request.id);
    requests.clear();
    if (active != null && !active.awaitingResult) complete(active, false);
  }

  void complete(MediaRequest request, boolean admitted) {
    if (active != request) return;
    active = null;
    MainActivity activity = MainActivity.current;
    if (activity != null && activity.permissionRequest == request) {
      activity.permissionOwner = null;
      activity.permissionRequest = null;
    }
    if (!admitted) request.owner.captureEnded(request.id);
    processRequests();
  }

  static void runtimeStopped(Runtime owner, String reason) {
    AppRuntimeService service = instance;
    if (service == null || service.runtime != owner) return;
    service.failure = new IllegalStateException(reason);
    service.runtime = null;
    service.requests.clear();
    service.active = null;
    MainActivity.retireDocument();
    CaptureService.shutdown();
    service.notifyActivity();
  }

  static void stop() {
    if (instance != null) instance.stopSelf();
  }

  @Override
  public void onDestroy() {
    if (instance == this) {
      instance = null;
      MainActivity.retireDocument();
      CaptureService.shutdown();
    }
    CompletableFuture<Runtime> pending = startup;
    startup = null;
    Runtime retired = runtime;
    runtime = null;
    requests.clear();
    active = null;
    work.execute(
        () -> {
          Runtime closing = retired;
          if (pending != null) {
            try {
              closing = pending.join();
            } catch (CompletionException ignored) {
            }
          }
          if (closing != null) {
            try {
              closing.close();
            } catch (Exception error) {
              android.util.Log.w("PiikRuntime", "runtime shutdown failed", error);
            }
          }
        });
    work.shutdown();
    stopForeground(STOP_FOREGROUND_REMOVE);
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
