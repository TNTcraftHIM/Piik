package tv.piik.android;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
import java.util.concurrent.*;

// One user-started Service owns the Rust App until stop and join complete.
public final class AppRuntimeService extends Service {
  static volatile AppRuntimeService instance;
  static final Handler main = new Handler(Looper.getMainLooper());
  // One queue also orders the old Service's join before a replacement's start.
  static final ExecutorService work = Executors.newSingleThreadExecutor();
  NativeRuntime runtime;
  CompletableFuture<NativeRuntime> startup;
  Throwable failure;

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
    startForeground(
        3,
        notification(),
        Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0);
  }

  void refreshNotification() {
    getSystemService(NotificationManager.class).notify(3, notification());
  }

  Notification notification() {
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
    int title =
        failure != null ? R.string.runtime_failed : runtime != null ? R.string.runtime_title : R.string.preparing;
    int body =
        failure != null ? R.string.runtime_restart : runtime != null ? R.string.runtime_body : R.string.runtime_channel;
    return new Notification.Builder(this, "piik-runtime")
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .setContentTitle(getString(title))
            .setContentText(getString(body))
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(
                new Notification.Action.Builder(null, getString(R.string.runtime_open), open)
                    .build())
            .addAction(
                new Notification.Action.Builder(null, getString(R.string.runtime_stop), stop)
                    .build())
            .build();
  }

  void startRuntime() {
    CompletableFuture<NativeRuntime> starting = CompletableFuture.supplyAsync(() -> {
      try { return NativeRuntime.start(getApplicationContext()); }
      catch (Exception error) { throw new CompletionException(error); }
    }, work);
    startup = starting;
    starting.whenComplete((started, error) -> main.post(() -> {
      if (instance != this || startup != starting) return;
      startup = null;
      runtime = started;
      failure = error;
      if (error != null) android.util.Log.e("PiikRuntime", "runtime startup failed", error);
      else android.util.Log.i("PiikRuntime", "runtime ready: " + started.entryURL());
      if (started != null) started.stopped.thenAccept(reason -> main.post(() -> {
        if (instance != this || runtime != started) return;
        runtime = null;
        failure = new IllegalStateException(reason.isEmpty() ? "App runtime stopped" : reason);
        android.util.Log.e("PiikRuntime", "runtime stopped", failure);
        work.execute(() -> closeRuntime(started));
        refreshNotification();
        notifyActivity();
      }));
      refreshNotification();
      notifyActivity();
    }));
  }

  static void closeRuntime(NativeRuntime runtime) {
    try {
      runtime.close();
      android.util.Log.i("PiikRuntime", "runtime stopped and joined");
    }
    catch (RuntimeException error) { android.util.Log.w("PiikRuntime", "runtime shutdown failed", error); }
  }

  void notifyActivity() {
    MainActivity activity = MainActivity.current;
    if (activity != null && activity.visible) activity.runtimeAvailable(this);
  }

  static void stop() {
    if (instance != null) instance.stopSelf();
  }

  @Override
  public void onDestroy() {
    if (instance == this) {
      instance = null;
    }
    CompletableFuture<NativeRuntime> pending = startup;
    startup = null;
    NativeRuntime retired = runtime;
    runtime = null;
    work.execute(
        () -> {
          NativeRuntime closing = retired;
          if (pending != null) {
            try {
              closing = pending.join();
            } catch (CompletionException ignored) {
            }
          }
          if (closing != null) closeRuntime(closing);
        });
    stopForeground(STOP_FOREGROUND_REMOVE);
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
