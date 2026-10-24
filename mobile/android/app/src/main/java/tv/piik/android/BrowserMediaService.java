package tv.piik.android;

import android.app.*;
import android.content.*;
import android.os.Binder;
import android.os.IBinder;

// Supplies Android's while-in-use eligibility only; WebView still owns all capture.
public final class BrowserMediaService extends Service {
  static BrowserMediaService instance;
  BrowserMedia owner;
  int types;

  static final class Request extends Binder {
    final BrowserMedia owner;
    final Runnable ready, failed;

    Request(BrowserMedia owner, Runnable ready, Runnable failed) {
      this.owner = owner;
      this.ready = ready;
      this.failed = failed;
    }
  }

  static void update(BrowserMedia owner, Runnable ready, Runnable failed) {
    int desired = owner.allowedTypes();
    BrowserMediaService service = instance;
    if (desired == 0) {
      retire(owner);
      if (failed != null) failed.run();
      return;
    }
    if (service != null && service.owner == owner && service.types == desired) {
      if (ready != null) ready.run();
      return;
    }
    MainActivity activity = MainActivity.current;
    boolean upgrading =
        service == null || service.owner != owner || (desired & ~service.types) != 0;
    if (upgrading && (activity == null || !activity.visible)) {
      if (failed != null) failed.run();
      return;
    }
    Request request = new Request(owner, ready, failed);
    if (service != null && service.owner != null) {
      service.apply(request);
      return;
    }
    Intent intent = new Intent(owner.context, BrowserMediaService.class);
    android.os.Bundle extras = new android.os.Bundle();
    extras.putBinder("owner", request);
    intent.putExtras(extras);
    try {
      owner.context.startForegroundService(intent);
    } catch (RuntimeException error) {
      android.util.Log.w("PiikBrowserMedia", "foreground media admission failed", error);
      if (failed != null) failed.run();
    }
  }

  static void retire(BrowserMedia owner) {
    if (instance != null && instance.owner == owner) {
      instance.owner = null;
      instance.types = 0;
      instance.stopForeground(STOP_FOREGROUND_REMOVE);
      instance.stopSelf();
    }
  }

  @Override
  public void onCreate() {
    super.onCreate();
    instance = this;
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    IBinder binder =
        intent == null || intent.getExtras() == null ? null : intent.getExtras().getBinder("owner");
    if (binder instanceof Request) apply((Request) binder);
    if (owner == null) stopSelfResult(startId);
    return START_NOT_STICKY;
  }

  void apply(Request request) {
    int desired = request.owner.allowedTypes();
    if (desired == 0) {
      if (request.failed != null) request.failed.run();
      return;
    }
    try {
      NotificationManager notifications = getSystemService(NotificationManager.class);
      notifications.createNotificationChannel(
          new NotificationChannel(
              "piik-browser-media",
              getString(R.string.browser_media_channel),
              NotificationManager.IMPORTANCE_LOW));
      PendingIntent open =
          PendingIntent.getActivity(
              this,
              0,
              new Intent(this, MainActivity.class),
              PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
      Notification notice =
          new Notification.Builder(this, "piik-browser-media")
              .setSmallIcon(android.R.drawable.ic_menu_camera)
              .setContentTitle(getString(R.string.browser_media_title))
              .setContentText(getString(R.string.browser_media_body))
              .setContentIntent(open)
              .setOngoing(true)
              .build();
      // Camera/microphone service types were introduced in Android 11.
      startForeground(2, notice, android.os.Build.VERSION.SDK_INT >= 30 ? desired : 0);
      owner = request.owner;
      types = desired;
    } catch (RuntimeException error) {
      android.util.Log.w("PiikBrowserMedia", "foreground media type admission failed", error);
      if (request.failed != null) request.failed.run();
      if (owner == null) stopSelf();
      return;
    }
    if (request.ready != null) request.ready.run();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public void onDestroy() {
    if (instance == this) instance = null;
    owner = null;
    types = 0;
    super.onDestroy();
  }
}
