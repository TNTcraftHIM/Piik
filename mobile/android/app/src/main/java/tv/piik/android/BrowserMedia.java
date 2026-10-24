package tv.piik.android;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.webkit.PermissionRequest;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebView;
import java.util.ArrayDeque;
import java.util.IdentityHashMap;
import org.json.JSONObject;
import tv.piik.androidbridge.Runtime;

// One approved main document owns this port and its Browser camera/microphone demand.
final class BrowserMedia {
  static final int MAX_STATE_MESSAGE_LENGTH = 256;
  final Context context;
  final Runtime runtime;
  final WebView web;
  final Uri origin;
  final WebMessagePort port;
  final IdentityHashMap<PermissionRequest, Preparation> requests = new IdentityHashMap<>();
  final ArrayDeque<PermissionRequest> synchronizing = new ArrayDeque<>();
  int requested = -1;

  static final class Preparation {
    final int types;
    Runnable denied;

    Preparation(int types, Runnable denied) {
      this.types = types;
      this.denied = denied;
    }
  }

  BrowserMedia(Runtime runtime, WebView web, String url) {
    this.context = web.getContext().getApplicationContext();
    this.runtime = runtime;
    this.web = web;
    Uri page = Uri.parse(url);
    origin =
        new Uri.Builder()
            .scheme(page.getScheme())
            .encodedAuthority(page.getEncodedAuthority())
            .build();
    WebMessagePort[] channel = web.createWebMessageChannel();
    port = channel[0];
    port.setWebMessageCallback(
        new WebMessagePort.WebMessageCallback() {
          @Override
          public void onMessage(WebMessagePort received, WebMessage message) {
            if (!current() || received != port) return;
            String data = message.getData();
            if (data == null || data.length() > MAX_STATE_MESSAGE_LENGTH) return;
            try {
              JSONObject state = new JSONObject(data);
              if (!state.getString("type").equals("media-state")
                  || !(state.get("microphone") instanceof Boolean)
                  || !(state.get("camera") instanceof Boolean)) return;
              requested =
                  (state.getBoolean("microphone")
                          ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                          : 0)
                      | (state.getBoolean("camera")
                          ? ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
                          : 0);
              if (state.optBoolean("synchronized", false)) {
                PermissionRequest request = synchronizing.poll();
                if (request != null) requests.remove(request);
              }
              BrowserMediaService.update(BrowserMedia.this, null, null);
            } catch (org.json.JSONException ignored) {
              // The port accepts only the bounded Browser media-state shape.
            }
          }
        });
    web.postWebMessage(
        new WebMessage("piik-browser-media", new WebMessagePort[] {channel[1]}), origin);
  }

  boolean current() {
    return MainActivity.browserMedia == this
        && MainActivity.runtime == runtime
        && MainActivity.web == web
        && web.getUrl() != null
        && MainActivity.sameOrigin(origin, Uri.parse(web.getUrl()))
        && runtime.trustedURL(web.getUrl());
  }

  int allowedTypes() {
    if (!current()) return 0;
    int types = Math.max(0, requested);
    for (Preparation request : requests.values()) types |= request.types;
    if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
        != PackageManager.PERMISSION_GRANTED)
      types &= ~ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
    if (context.checkSelfPermission(Manifest.permission.CAMERA)
        != PackageManager.PERMISSION_GRANTED) types &= ~ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
    return types;
  }

  void prepare(PermissionRequest request, Runnable granted, Runnable denied) {
    if (!current()) {
      denied.run();
      return;
    }
    // Older hosted UIs retain ordinary foreground WebView capture permission.
    if (requested < 0) {
      granted.run();
      return;
    }
    int types = 0;
    for (String resource : request.getResources()) {
      if (resource.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
      if (resource.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
        types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
    }
    Preparation pending = new Preparation(types, denied);
    requests.put(request, pending);
    BrowserMediaService.update(
        this,
        () -> {
          if (requests.get(request) != pending) return;
          if (!current() || (allowedTypes() & pending.types) != pending.types) {
            cancel(request);
            denied.run();
            return;
          }
          pending.denied = null;
          granted.run();
          // This response, unlike an earlier queued snapshot, observes the grant.
          synchronizing.add(request);
          port.postMessage(new WebMessage("media-sync"));
        },
        () -> {
          if (requests.remove(request) == pending) denied.run();
          BrowserMediaService.update(this, null, null);
        });
  }

  void cancel(PermissionRequest request) {
    requests.remove(request);
    BrowserMediaService.update(this, null, null);
  }

  void close() {
    if (MainActivity.browserMedia == this) MainActivity.browserMedia = null;
    port.close();
    java.util.ArrayList<Preparation> retired = new java.util.ArrayList<>(requests.values());
    requests.clear();
    synchronizing.clear();
    BrowserMediaService.retire(this);
    for (Preparation pending : retired) if (pending.denied != null) pending.denied.run();
  }
}
