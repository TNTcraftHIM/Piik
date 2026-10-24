package tv.piik.android;

import android.app.*;
import android.content.*;
import android.media.*;
import android.media.projection.*;
import android.net.*;
import android.os.*;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import java.net.Inet4Address;
import java.util.concurrent.*;
import tv.piik.androidbridge.*;

public final class MainActivity extends Activity {
  static MainActivity current;
  static volatile tv.piik.androidbridge.Runtime runtime;
  static WebView web;
  static final Handler main = new Handler(Looper.getMainLooper());
  static final ExecutorService work = Executors.newSingleThreadExecutor();
  static CompletableFuture<tv.piik.androidbridge.Runtime> startup;
  static long pendingVideo;
  static String pendingConfig;
  static BrowserMedia browserMedia;
  static final int CAPTURE = 10;
  WebPermissions permissions;
  Dialog sitePopup;
  FullscreenView fullscreen;
  boolean visible;

  @Override
  protected void onStart() {
    super.onStart();
    visible = true;
  }

  @Override
  protected void onStop() {
    visible = false;
    if (browserMedia != null) browserMedia.background();
    super.onStop();
  }

  static void refreshBrowserMedia() {
    if (browserMedia != null && !browserMedia.current()) {
      BrowserMedia previous = browserMedia;
      boolean revoked =
          previous.runtime == runtime
              && previous.web == web
              && web.getUrl() != null
              && sameOrigin(previous.origin, Uri.parse(web.getUrl()))
              && !runtime.trustedURL(web.getUrl());
      previous.close();
      if (revoked) {
        if (current != null && current.sitePopup != null) current.sitePopup.dismiss();
        web.loadUrl(runtime.url());
        return;
      }
    }
    if (browserMedia == null
        && runtime != null
        && web != null
        && web.getUrl() != null
        && runtime.trustedURL(web.getUrl()))
      browserMedia = new BrowserMedia(runtime, web, web.getUrl());
  }

  @Override
  public void onCreate(Bundle state) {
    super.onCreate(state);
    current = this;
    permissions = new WebPermissions(this);
    fullscreen = new FullscreenView(this);
    if (web != null) {
      if (web.getParent() instanceof android.view.ViewGroup)
        ((android.view.ViewGroup) web.getParent()).removeView(web);
      setContentView(WindowContent.wrap(getWindow(), web));
      return;
    }
    TextView waiting = new TextView(this);
    waiting.setPadding(24, 48, 24, 24);
    waiting.setText(getString(R.string.preparing));
    setContentView(WindowContent.wrap(getWindow(), waiting));
    if (WebView.getCurrentWebViewPackage() == null) {
      waiting.setText(getString(R.string.no_webview));
      return;
    }
    if (runtime != null) {
      showWeb(runtime.entryURL());
      return;
    }
    if (startup != null) {
      if (startup.isCompletedExceptionally()) showRuntimeFailure();
      return;
    }
    CompletableFuture<tv.piik.androidbridge.Runtime> starting =
        CompletableFuture.supplyAsync(
            () -> {
              try {
                String capabilities = codecCapabilities();
                ConnectivityManager cm = getSystemService(ConnectivityManager.class);
                LinkProperties links = cm.getLinkProperties(cm.getActiveNetwork());
                String address = "";
                if (links != null)
                  for (LinkAddress link : links.getLinkAddresses())
                    if (link.getAddress() instanceof Inet4Address
                        && !link.getAddress().isLoopbackAddress()) {
                      address = link.getAddress().getHostAddress();
                      break;
                    }
                CapturePlatform platform = new CapturePlatform(getApplicationContext());
                var started =
                    Androidbridge.start(
                        platform,
                        address,
                        capabilities,
                        getFilesDir().getAbsolutePath(),
                        getCacheDir().getAbsolutePath(),
                        new java.io.File(getApplicationInfo().nativeLibraryDir, "libcloudflared.so")
                            .getAbsolutePath());
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
                  if (startup != starting) {
                    if (started != null) work.execute(() -> closeRuntime(started));
                    return;
                  }
                  startup = null;
                  MainActivity active = current;
                  if (active == null || active.isFinishing() || active.isDestroyed()) {
                    if (started != null) work.execute(() -> closeRuntime(started));
                    return;
                  }
                  if (error != null) {
                    TextView failure = new TextView(active);
                    failure.setPadding(24, 48, 24, 24);
                    failure.setText("Piik\n" + error.getCause().getMessage());
                    active.setContentView(WindowContent.wrap(active.getWindow(), failure));
                    return;
                  }
                  runtime = started;
                  active.showWeb(started.entryURL());
                }));
  }

  static String codecCapabilities() throws Exception {
    return EncoderCatalog.capabilities();
  }

  void showWeb(String url) {
    web = new WebView(getApplicationContext());
    WebSettings settings = web.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setMediaPlaybackRequiresUserGesture(false);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    settings.setSupportMultipleWindows(true);
    web.setWebViewClient(new AppWebClient());
    // No JavaScript interface is exposed. Only the current approved Piik origin can
    // reach the Go control endpoint, whose existing Origin checks remain active.
    web.setWebChromeClient(new AppChromeClient());
    setContentView(WindowContent.wrap(getWindow(), web));
    web.loadUrl(url);
    if (EncoderCatalog.candidates("auto").isEmpty())
      new AlertDialog.Builder(this)
          .setMessage(R.string.no_capture)
          .setPositiveButton(android.R.string.ok, null)
          .show();
  }

  static class AppWebClient extends WebViewClient {
    @Override
    public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
      if (view == web && browserMedia != null) browserMedia.close();
    }

    @Override
    public void onPageFinished(WebView view, String url) {
      if (view == web && java.util.Objects.equals(view.getUrl(), url)) refreshBrowserMedia();
    }

    @Override
    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
      if (view == web && browserMedia != null) browserMedia.close();
      return false;
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
      Uri uri = request.getUrl();
      boolean trusted = runtime != null && runtime.trustedURL(uri.toString());
      if (!trusted) {
        try {
          current.startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
        }
      }
      return !trusted;
    }
  }

  static final class AppChromeClient extends WebChromeClient {
    @Override
    public void onShowCustomView(View view, CustomViewCallback callback) {
      if (current == null) callback.onCustomViewHidden();
      else current.fullscreen.show(view, callback);
    }

    @Override
    public void onHideCustomView() {
      if (current != null) current.fullscreen.hide();
    }

    @Override
    public void onPermissionRequest(PermissionRequest request) {
      main.post(
          () -> {
            if (current != null) current.permissions.request(request);
            else request.deny();
          });
    }

    @Override
    public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, Message result) {
      if (!gesture || current == null) return false;
      WebView child = current.showSitePopup();
      // Preserve the actual opener so approval can notify it and close this child.
      ((WebView.WebViewTransport) result.obj).setWebView(child);
      result.sendToTarget();
      return true;
    }

    @Override
    public void onPermissionRequestCanceled(PermissionRequest request) {
      main.post(
          () -> {
            if (current != null) current.permissions.cancel(request);
          });
    }
  }

  WebView showSitePopup() {
    WebView child = new WebView(getApplicationContext());
    child.getSettings().setJavaScriptEnabled(true);
    child.getSettings().setDomStorageEnabled(true);
    child.getSettings().setAllowFileAccess(false);
    child.getSettings().setAllowContentAccess(false);
    child.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    MainActivity owner = this;
    if (owner.sitePopup != null) owner.sitePopup.dismiss();
    Dialog popup = new Dialog(owner);
    owner.sitePopup = popup;
    final var managerRuntime = runtime;
    final Uri manager = Uri.parse(managerRuntime.url());
    child.setWebViewClient(
        new AppWebClient() {
          @Override
          public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri target = request.getUrl();
            if (request.isForMainFrame()
                && managerRuntime == runtime
                && !sameOrigin(manager, target)
                && managerRuntime.trustedURL(target.toString())) {
              // Opening a saved site is navigation; editing permission keeps the Host alive.
              web.loadUrl(target.toString());
              popup.dismiss();
              return true;
            }
            return super.shouldOverrideUrlLoading(view, request);
          }
        });
    popup.setContentView(WindowContent.wrap(popup.getWindow(), child));
    child.setWebChromeClient(
        new WebChromeClient() {
          @Override
          public void onCloseWindow(WebView window) {
            popup.dismiss();
          }
        });
    popup.setOnDismissListener(
        ignored -> {
          child.destroy();
          if (owner.sitePopup == popup) owner.sitePopup = null;
        });
    popup.show();
    popup
        .getWindow()
        .setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    return child;
  }

  static void requestAudio(long id) {
    var owner = runtime;
    if (owner == null || !owner.captureCurrent(id)) return;
    if (current == null) {
      owner.captureEnded(id);
      return;
    }
    current.permissions.audio(
        () -> {
          if (runtime == owner && owner.captureCurrent(id)) CaptureService.startAudio(owner, id);
        },
        () -> owner.captureEnded(id));
  }

  static void requestMicrophone(long id, String device) {
    var owner = runtime;
    if (owner == null || !owner.captureCurrent(id)) return;
    if (current == null) {
      owner.captureEnded(id);
      return;
    }
    current.permissions.audio(
        () -> {
          if (runtime == owner && owner.captureCurrent(id))
            CaptureService.startMicrophone(owner, id, device);
        },
        () -> owner.captureEnded(id));
  }

  boolean trustedPermission(PermissionRequest request) {
    if (runtime == null || web == null || web.getUrl() == null || !runtime.trustedURL(web.getUrl()))
      return false;
    Uri top = Uri.parse(web.getUrl()), origin = request.getOrigin();
    return sameOrigin(top, origin);
  }

  static int effectivePort(Uri uri) {
    return uri.getPort() >= 0 ? uri.getPort() : "https".equals(uri.getScheme()) ? 443 : 80;
  }

  static boolean sameOrigin(Uri left, Uri right) {
    return java.util.Objects.equals(left.getScheme(), right.getScheme())
        && java.util.Objects.equals(left.getHost(), right.getHost())
        && effectivePort(left) == effectivePort(right);
  }

  @Override
  public boolean onCreateOptionsMenu(Menu menu) {
    menu.add(0, 3, 0, R.string.start_page);
    menu.add(0, 1, 1, R.string.choose_site);
    return true;
  }

  @Override
  public boolean onOptionsItemSelected(MenuItem item) {
    if (item.getItemId() == 3) {
      startPage();
      return true;
    }
    if (item.getItemId() == 1) {
      chooseSite();
      return true;
    }
    return super.onOptionsItemSelected(item);
  }

  void chooseSite() {
    if (runtime != null && web != null) showSitePopup().loadUrl(runtime.url());
  }

  void startPage() {
    final var owner = runtime;
    if (owner == null || web == null || java.util.Objects.equals(web.getUrl(), owner.url())) return;
    new AlertDialog.Builder(this)
        .setMessage(R.string.start_page_prompt)
        .setNegativeButton(android.R.string.cancel, null)
        .setPositiveButton(
            android.R.string.ok,
            (dialog, which) -> {
              if (runtime == owner && web != null) web.loadUrl(owner.url());
            })
        .show();
  }

  static void requestVideo(long id, String configuration) {
    final var runtime = MainActivity.runtime;
    if (runtime == null || !runtime.captureCurrent(id)) return;
    // Keep the exact request until Android returns its result, even if Go
    // retires it meanwhile. A later request cannot inherit that consent.
    if (pendingVideo != 0) {
      runtime.captureEnded(id);
      if (current != null) Toast.makeText(current, R.string.consent_busy, Toast.LENGTH_LONG).show();
      return;
    }
    if (CaptureService.replaceVideo(runtime, id, configuration)) return;
    MainActivity activity = current;
    if (activity == null) {
      runtime.captureEnded(id);
      return;
    }
    pendingVideo = id;
    pendingConfig = configuration;
    activity.projectionConsent();
  }

  void projectionConsent() {
    final var runtime = MainActivity.runtime;
    if (runtime == null || pendingVideo == 0 || !runtime.captureCurrent(pendingVideo)) {
      pendingVideo = 0;
      return;
    }
    try {
      MediaProjectionManager manager = getSystemService(MediaProjectionManager.class);
      Intent consent =
          Build.VERSION.SDK_INT >= 34
              ? manager.createScreenCaptureIntent(
                  MediaProjectionConfig.createConfigForDefaultDisplay())
              : manager.createScreenCaptureIntent();
      startActivityForResult(consent, CAPTURE);
    } catch (Exception error) {
      runtime.captureEnded(pendingVideo);
      pendingVideo = 0;
      new AlertDialog.Builder(this)
          .setMessage(getString(R.string.capture_unavailable, error.getMessage()))
          .setPositiveButton(android.R.string.ok, null)
          .show();
    }
  }

  @Override
  public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
    super.onRequestPermissionsResult(request, permissions, results);
    if (request == WebPermissions.REQUEST) this.permissions.finish();
  }

  @Override
  protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    final var runtime = MainActivity.runtime;
    android.util.Log.d(
        "PiikCapture",
        "projection result received; current="
            + (current == this)
            + ", pending="
            + (pendingVideo != 0)
            + ", accepted="
            + (result == RESULT_OK));
    if (current != this || request != CAPTURE || pendingVideo == 0 || runtime == null) return;
    long id = pendingVideo;
    pendingVideo = 0;
    if (result != RESULT_OK || data == null) {
      runtime.captureEnded(id);
      return;
    }
    if (!runtime.captureCurrent(id)) return;
    Intent service =
        new Intent(this, CaptureService.class)
            .putExtra("result", result)
            .putExtra("data", data)
            .putExtra("id", id)
            .putExtra("config", pendingConfig);
    Bundle ownership = new Bundle();
    ownership.putBinder("owner", new CaptureService.ProjectionOwner(runtime));
    service.putExtras(ownership);
    startForegroundService(service);
  }

  @Override
  public void onBackPressed() {
    if (fullscreen.hide()) return;
    if (web != null && web.canGoBack()) {
      web.goBack();
      return;
    }
    new AlertDialog.Builder(this)
        .setMessage(R.string.leave_prompt)
        .setNegativeButton(android.R.string.cancel, null)
        .setPositiveButton(
            android.R.string.ok,
            (d, w) -> {
              CaptureService.shutdown();
              if (browserMedia != null) browserMedia.close();
              var old = runtime;
              runtime = null;
              startup = null;
              pendingVideo = 0;
              pendingConfig = null;
              if (old != null) work.execute(() -> closeRuntime(old));
              if (web != null) {
                web.destroy();
                web = null;
              }
              finish();
            })
        .show();
  }

  @Override
  protected void onDestroy() {
    fullscreen.hide();
    if (sitePopup != null) sitePopup.dismiss();
    permissions.close();
    if (current == this) current = null;
    super.onDestroy();
  }

  static void closeRuntime(tv.piik.androidbridge.Runtime owner) {
    try {
      owner.close();
    } catch (Exception error) {
      android.util.Log.w("PiikRuntime", "runtime shutdown failed", error);
    }
  }

  static void runtimeStopped(tv.piik.androidbridge.Runtime owner, String reason) {
    if (owner == null || runtime != owner) return;
    runtime = null;
    startup = CompletableFuture.failedFuture(new IllegalStateException(reason));
    pendingVideo = 0;
    pendingConfig = null;
    if (browserMedia != null) browserMedia.close();
    CaptureService.shutdown();
    if (web != null) {
      web.destroy();
      web = null;
    }
    MainActivity active = current;
    if (active == null || active.isFinishing() || active.isDestroyed()) return;
    active.fullscreen.hide();
    if (active.sitePopup != null) active.sitePopup.dismiss();
    active.showRuntimeFailure();
  }

  void showRuntimeFailure() {
    LinearLayout failure = new LinearLayout(this);
    failure.setOrientation(LinearLayout.VERTICAL);
    failure.setPadding(24, 48, 24, 24);
    TextView message = new TextView(this);
    message.setText(R.string.public_link_stopped);
    failure.addView(message);
    Button restart = new Button(this);
    restart.setText(R.string.restart_piik);
    restart.setOnClickListener(
        ignored -> {
          startup = null;
          recreate();
        });
    failure.addView(restart);
    setContentView(WindowContent.wrap(getWindow(), failure));
  }
}
