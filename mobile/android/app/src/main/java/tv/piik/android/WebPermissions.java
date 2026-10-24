package tv.piik.android;

import android.Manifest;
import android.content.pm.PackageManager;
import android.webkit.PermissionRequest;
import java.util.ArrayDeque;
import java.util.ArrayList;

// The visible Activity owns Android consent. Web origins never receive Java APIs.
final class WebPermissions {
  static final int REQUEST = 11;
  final MainActivity activity;
  final ArrayDeque<Grant> pending = new ArrayDeque<>();
  Grant active;

  static final class Grant {
    PermissionRequest web;
    String[] permissions;
    Runnable complete, denied;
  }

  WebPermissions(MainActivity activity) {
    this.activity = activity;
  }

  void request(PermissionRequest request) {
    if (!activity.trustedPermission(request)) {
      request.deny();
      return;
    }
    ArrayList<String> permissions = new ArrayList<>();
    for (String resource : request.getResources()) {
      if (resource.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        permissions.add(Manifest.permission.RECORD_AUDIO);
      else if (resource.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
        permissions.add(Manifest.permission.CAMERA);
      else {
        request.deny();
        return;
      }
    }
    Grant grant = new Grant();
    grant.web = request;
    grant.permissions = permissions.toArray(new String[0]);
    grant.complete =
        () -> {
          if (!activity.trustedPermission(request)) {
            request.deny();
            return;
          }
          // A document can request capture before onPageFinished installs its
          // platform port. The real request still requires service preparation.
          MainActivity.refreshBrowserMedia();
          BrowserMedia media = MainActivity.browserMedia;
          if (media == null || !media.current()) {
            request.deny();
            return;
          }
          media.prepare(request, () -> request.grant(request.getResources()), request::deny);
        };
    grant.denied = request::deny;
    pending.add(grant);
    next();
  }

  void audio(Runnable complete, Runnable denied) {
    Grant grant = new Grant();
    grant.permissions = new String[] {Manifest.permission.RECORD_AUDIO};
    grant.complete = complete;
    grant.denied = denied;
    pending.add(grant);
    next();
  }

  void cancel(PermissionRequest request) {
    if (MainActivity.browserMedia != null) MainActivity.browserMedia.cancel(request);
    pending.removeIf(grant -> grant.web == request);
    if (active != null && active.web == request) {
      active.complete = () -> {};
      active.denied = () -> {};
    }
  }

  void next() {
    if (active != null || pending.isEmpty()) return;
    active = pending.remove();
    ArrayList<String> missing = new ArrayList<>();
    for (String permission : active.permissions)
      if (activity.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED)
        missing.add(permission);
    if (missing.isEmpty()) {
      finish();
      return;
    }
    if (!activity.visible) {
      finish();
      return;
    }
    activity.requestPermissions(missing.toArray(new String[0]), REQUEST);
  }

  void finish() {
    Grant grant = active;
    active = null;
    if (grant == null) return;
    boolean allowed = true;
    for (String permission : grant.permissions)
      allowed &= activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    if (allowed) grant.complete.run();
    else grant.denied.run();
    next();
  }

  void close() {
    if (active != null) {
      active.denied.run();
      active.complete = () -> {};
      active.denied = () -> {};
    }
    for (Grant grant : pending) grant.denied.run();
    pending.clear();
  }
}
