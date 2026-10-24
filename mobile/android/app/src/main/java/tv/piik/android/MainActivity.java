package tv.piik.android;

import android.app.*;
import android.content.*;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.webkit.*;
import android.widget.*;

public final class MainActivity extends Activity {
  static MainActivity current;
  static WebView web;
  static BrowserMedia browserMedia;
  static final Handler main = AppRuntimeService.main;
  WebPermissions permissions;
  Dialog sitePopup;
  FullscreenView fullscreen;
  boolean visible, handledMedia, notificationRequest;
  static final int NOTIFICATIONS = 13;
  AppRuntimeService permissionOwner;
  AppRuntimeService.MediaRequest permissionRequest;

  boolean mediaEntry() {
    return BuildConfig.EXTERNAL_BROWSER
        && getIntent().getData() != null
        && "piik://media".equals(getIntent().getData().toString());
  }

  boolean wakeEntry() {
    return getIntent().getData() != null && "piik://app".equals(getIntent().getData().toString());
  }

  boolean canConfirmMedia() {
    return !wakeEntry()
        && (!BuildConfig.EXTERNAL_BROWSER || getIntent().getData() == null || mediaEntry());
  }

  @Override
  public void onCreate(Bundle state) {
    super.onCreate(state);
    current = this;
    permissions = new WebPermissions(this);
    fullscreen = new FullscreenView(this);
    if (state != null) {
      handledMedia = state.getBoolean("handledMedia");
      notificationRequest = state.getBoolean("notificationRequest");
      AppRuntimeService service = AppRuntimeService.instance;
      if (service != null && service.active != null && service.active.awaitingResult) {
        permissionOwner = service;
        permissionRequest = service.active;
      }
    }
    Uri requested = getIntent().getData();
    if (requested != null && !wakeEntry() && !mediaEntry()) {
      finish();
      return;
    }
    if (!BuildConfig.EXTERNAL_BROWSER && web != null && !wakeEntry()) {
      if (web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web);
      setContentView(WindowContent.wrap(getWindow(), web));
    } else {
      TextView waiting = new TextView(this);
      waiting.setPadding(24, 48, 24, 24);
      waiting.setText(mediaEntry() ? R.string.media_waiting : R.string.preparing);
      setContentView(WindowContent.wrap(getWindow(), waiting));
    }
    if (Build.VERSION.SDK_INT >= 33
        && state == null
        && requested == null
        && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
            != android.content.pm.PackageManager.PERMISSION_GRANTED) {
      notificationRequest = true;
      requestPermissions(
          new String[] {android.Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATIONS);
    }
    startForegroundService(new Intent(this, AppRuntimeService.class));
  }

  @Override
  protected void onSaveInstanceState(Bundle state) {
    state.putBoolean("handledMedia", handledMedia);
    state.putBoolean("notificationRequest", notificationRequest);
    super.onSaveInstanceState(state);
  }

  @Override
  protected void onStart() {
    super.onStart();
    current = this;
    visible = true;
    if (AppRuntimeService.instance != null) runtimeAvailable(AppRuntimeService.instance);
  }

  @Override
  protected void onStop() {
    visible = false;
    if (browserMedia != null) browserMedia.background();
    super.onStop();
  }

  void runtimeAvailable(AppRuntimeService service) {
    if (current != this || !visible || isFinishing() || notificationRequest) return;
    if (service.failure != null) {
      showRuntimeFailure();
      return;
    }
    var owner = AppRuntimeService.runtime();
    if (owner == null) return;
    if (wakeEntry()) {
      finish();
      return;
    }
    if (BuildConfig.EXTERNAL_BROWSER) {
      if (mediaEntry()
          || (getIntent().getData() == null
              && (service.active != null || !service.requests.isEmpty()))) {
        service.processRequests();
        return;
      }
      if (getIntent().getData() == null) {
        try {
          startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(owner.entryURL())));
        } catch (ActivityNotFoundException error) {
          new AlertDialog.Builder(this)
              .setMessage(R.string.no_browser)
              .setPositiveButton(android.R.string.ok, (dialog, which) -> finish())
              .show();
          return;
        }
      }
      // App wake returns to its caller. Only the launcher entry opens a URL.
      finish();
    } else {
      if (web == null) {
        if (WebView.getCurrentWebViewPackage() == null) {
          TextView failure = new TextView(this);
          failure.setText(R.string.no_webview);
          setContentView(WindowContent.wrap(getWindow(), failure));
          return;
        }
        showWeb(owner.entryURL());
      }
      service.processRequests();
    }
  }

  void mediaStarted() {
    handledMedia = true;
  }

  void mediaFinished() {
    if (!BuildConfig.EXTERNAL_BROWSER) return;
    if (handledMedia) {
      finish();
      return;
    }
    if (!mediaEntry()) return;
    LinearLayout empty = new LinearLayout(this);
    empty.setOrientation(LinearLayout.VERTICAL);
    empty.setPadding(24, 48, 24, 24);
    TextView message = new TextView(this);
    message.setText(R.string.no_pending_confirmation);
    empty.addView(message);
    Button back = new Button(this);
    back.setText(R.string.return_browser);
    back.setOnClickListener(ignored -> finish());
    empty.addView(back);
    setContentView(WindowContent.wrap(getWindow(), empty));
  }

  static void refreshBrowserMedia() {
    if (BuildConfig.EXTERNAL_BROWSER) return;
    var owner = AppRuntimeService.runtime();
    if (browserMedia != null && !browserMedia.current()) {
      BrowserMedia previous = browserMedia;
      boolean revoked =
          previous.runtime == owner
              && previous.web == web
              && web.getUrl() != null
              && sameOrigin(previous.origin, Uri.parse(web.getUrl()))
              && !owner.trustedURL(web.getUrl());
      previous.close();
      if (revoked) {
        if (current != null && current.sitePopup != null) current.sitePopup.dismiss();
        web.loadUrl(owner.url());
        return;
      }
    }
    if (browserMedia == null
        && owner != null
        && web != null
        && web.getUrl() != null
        && owner.trustedURL(web.getUrl()))
      browserMedia = new BrowserMedia(owner, web, web.getUrl());
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
      boolean trusted =
          AppRuntimeService.runtime() != null
              && AppRuntimeService.runtime().trustedURL(uri.toString());
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
    final var managerRuntime = AppRuntimeService.runtime();
    final Uri manager = Uri.parse(managerRuntime.url());
    child.setWebViewClient(
        new AppWebClient() {
          @Override
          public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri target = request.getUrl();
            if (request.isForMainFrame()
                && managerRuntime == AppRuntimeService.runtime()
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

  boolean trustedPermission(PermissionRequest request) {
    if (AppRuntimeService.runtime() == null
        || web == null
        || web.getUrl() == null
        || !AppRuntimeService.runtime().trustedURL(web.getUrl())) return false;
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
    if (AppRuntimeService.runtime() != null && web != null)
      showSitePopup().loadUrl(AppRuntimeService.runtime().url());
  }

  void startPage() {
    final var owner = AppRuntimeService.runtime();
    if (owner == null || web == null || java.util.Objects.equals(web.getUrl(), owner.url())) return;
    new AlertDialog.Builder(this)
        .setMessage(R.string.start_page_prompt)
        .setNegativeButton(android.R.string.cancel, null)
        .setPositiveButton(
            android.R.string.ok,
            (dialog, which) -> {
              if (AppRuntimeService.runtime() == owner && web != null) web.loadUrl(owner.url());
            })
        .show();
  }

  @Override
  public void onRequestPermissionsResult(int request, String[] names, int[] results) {
    super.onRequestPermissionsResult(request, names, results);
    if (request == NOTIFICATIONS) {
      notificationRequest = false;
      if (AppRuntimeService.instance != null) runtimeAvailable(AppRuntimeService.instance);
    } else if (request == WebPermissions.REQUEST) permissions.finish();
    else if (request == AppRuntimeService.AUDIO_PERMISSION && permissionOwner != null) {
      AppRuntimeService owner = permissionOwner;
      AppRuntimeService.MediaRequest pending = permissionRequest;
      permissionOwner = null;
      permissionRequest = null;
      owner.audioPermissionResult(pending);
    }
  }

  @Override
  protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request == AppRuntimeService.PROJECTION && permissionOwner != null) {
      AppRuntimeService owner = permissionOwner;
      AppRuntimeService.MediaRequest pending = permissionRequest;
      permissionOwner = null;
      permissionRequest = null;
      owner.projectionResult(this, pending, result, data);
    }
  }

  @Override
  public void onBackPressed() {
    if (fullscreen.hide()) return;
    if (BuildConfig.EXTERNAL_BROWSER) {
      if ((mediaEntry() || handledMedia) && AppRuntimeService.instance != null)
        AppRuntimeService.instance.cancelPending();
      finish();
      return;
    }
    if (web != null && web.canGoBack()) {
      web.goBack();
      return;
    }
    new AlertDialog.Builder(this)
        .setMessage(R.string.leave_prompt)
        .setNegativeButton(android.R.string.cancel, null)
        .setPositiveButton(
            android.R.string.ok,
            (dialog, which) -> {
              AppRuntimeService.stop();
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

  static void retireDocument() {
    if (browserMedia != null) browserMedia.close();
    if (web != null) {
      web.destroy();
      web = null;
    }
    MainActivity activity = current;
    if (activity != null) {
      activity.fullscreen.hide();
      if (activity.sitePopup != null) activity.sitePopup.dismiss();
    }
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
          AppRuntimeService.stop();
          finish();
          startActivity(new Intent(this, MainActivity.class));
        });
    failure.addView(restart);
    setContentView(WindowContent.wrap(getWindow(), failure));
  }
}
