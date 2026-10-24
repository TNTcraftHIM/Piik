package tv.piik.android;

import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.media.*;
import android.media.projection.*;
import android.net.*;
import android.os.*;
import android.webkit.*;
import android.widget.*;
import java.net.Inet4Address;
import java.util.concurrent.*;
import org.json.JSONObject;
import tv.piik.androidbridge.*;

public final class MainActivity extends Activity {
  static MainActivity current;
  static volatile tv.piik.androidbridge.Runtime runtime;
  static WebView web;
  static final Handler main = new Handler(Looper.getMainLooper());
  static final ExecutorService work = Executors.newSingleThreadExecutor();
  static long pendingVideo;
  static String pendingConfig;
  static String encoderName;
  static final int CAPTURE = 10, AUDIO = 11;

  @Override
  public void onCreate(Bundle state) {
    super.onCreate(state);
    current = this;
    if (web != null) {
      if (web.getParent() instanceof android.view.ViewGroup)
        ((android.view.ViewGroup) web.getParent()).removeView(web);
      setContentView(web);
      return;
    }
    TextView waiting = new TextView(this);
    waiting.setPadding(24, 48, 24, 24);
    waiting.setText(getString(R.string.preparing));
    setContentView(waiting);
    if (WebView.getCurrentWebViewPackage() == null) {
      waiting.setText(getString(R.string.no_webview));
      return;
    }
    work.execute(
        () -> {
          try {
            String capabilities = codecCapabilities();
            ConnectivityManager cm = getSystemService(ConnectivityManager.class);
            LinkProperties links = cm.getLinkProperties(cm.getActiveNetwork());
            String address = null;
            if (links != null)
              for (LinkAddress link : links.getLinkAddresses())
                if (link.getAddress() instanceof Inet4Address
                    && !link.getAddress().isLoopbackAddress()) {
                  address = link.getAddress().getHostAddress();
                  break;
                }
            if (address == null) throw new Exception(getString(R.string.no_network));
            final tv.piik.androidbridge.Runtime started =
                Androidbridge.start(
                    new Platform() {
                      public void startVideo(long id, String config) {
                        main.post(() -> requestVideo(id, config));
                      }

                      public void startAudio(long id) {
                        CaptureService.startAudio(id);
                      }

                      public void control(long id, String command, long layer, long value) {
                        CaptureService.control(id, command, value);
                      }

                      public void stop(long id) {
                        main.post(
                            () -> {
                              CaptureService.stopCapture(id);
                            });
                      }
                    },
                    address,
                    capabilities);
            runtime = started;
            main.post(
                () -> {
                  if (current == this && !isFinishing() && !isDestroyed() && runtime == started)
                    showWeb(started.url());
                });
          } catch (Exception error) {
            main.post(() -> waiting.setText("Piik\n" + error.getMessage()));
          }
        });
  }

  static String codecCapabilities() throws Exception {
    JSONObject result = new JSONObject();
    result.put("video", false);
    for (String wanted : new String[] {"video/avc", "video/x-vnd.on2.vp8"})
      for (MediaCodecInfo codec : new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos())
        if (codec.isEncoder() && (!wanted.equals("video/avc") || codec.isHardwareAccelerated()))
          for (String type : codec.getSupportedTypes())
            if (type.equalsIgnoreCase(wanted)) {
              MediaCodecInfo.CodecCapabilities capabilities = codec.getCapabilitiesForType(type);
              boolean surface = false;
              for (int color : capabilities.colorFormats)
                if (color == MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface) surface = true;
              if (!surface) continue;
              MediaCodecInfo.VideoCapabilities video =
                  codec.getCapabilitiesForType(type).getVideoCapabilities();
              encoderName = codec.getName();
              result.put("video", true);
              result.put("name", encoderName);
              result.put("codec", wanted.equals("video/avc") ? "h264" : "vp8");
              result.put("width", Math.min(1920, video.getSupportedWidths().getUpper()));
              result.put("height", Math.min(1920, video.getSupportedHeights().getUpper()));
              int width = Math.min(1920, video.getSupportedWidths().getUpper());
              width -= width % video.getWidthAlignment();
              int height = Math.min(1920, video.getSupportedHeightsFor(width).getUpper());
              height -= height % video.getHeightAlignment();
              double rate = Math.min(60, video.getSupportedFrameRatesFor(width, height).getUpper());
              result.put("pixels", (long) width * height);
              result.put(
                  "macroblocks",
                  Math.min(
                      2073600L, (long) ((width + 15) / 16) * ((height + 15) / 16) * (long) rate));
              result.put("fps", Math.min(60, video.getSupportedFrameRates().getUpper()));
              result.put("bitrate", Math.min(100000000, video.getBitrateRange().getUpper()));
              return result.toString();
            }
    return result.toString();
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
    web.setWebViewClient(
        new WebViewClient() {
          @Override
          public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            boolean trusted =
                "http".equals(uri.getScheme())
                    && "127.0.0.1".equals(uri.getHost())
                    && uri.getPort() == 8787;
            if (!trusted) {
              try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
              } catch (Exception ignored) {
              }
            }
            return !trusted;
          }
        });
    // No JavaScript interface is exposed. Only the trusted local Piik page can
    // reach the Go control endpoint, whose existing Origin checks remain active.
    web.setWebChromeClient(
        new WebChromeClient() {
          @Override
          public void onPermissionRequest(PermissionRequest request) {
            main.post(() -> request.deny());
          }
        });
    setContentView(web);
    web.loadUrl(url);
    if (encoderName == null)
      new AlertDialog.Builder(this)
          .setMessage(R.string.no_capture)
          .setPositiveButton(android.R.string.ok, null)
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
    if (CaptureService.replaceVideo(id, configuration)) return;
    MainActivity activity = current;
    if (activity == null) {
      runtime.captureEnded(id);
      return;
    }
    pendingVideo = id;
    pendingConfig = configuration;
    if (activity.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
        != PackageManager.PERMISSION_GRANTED) {
      activity.requestPermissions(new String[] {android.Manifest.permission.RECORD_AUDIO}, AUDIO);
    } else activity.projectionConsent();
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
    if (request == AUDIO) projectionConsent();
  }

  @Override
  protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    final var runtime = MainActivity.runtime;
    if (request != CAPTURE || pendingVideo == 0 || runtime == null) return;
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
    startForegroundService(service);
  }

  @Override
  public void onBackPressed() {
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
              // Also retires startup that is still running on this same queue.
              work.execute(
                  () -> {
                    var old = runtime;
                    runtime = null;
                    if (old != null) old.close();
                  });
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
    if (current == this) current = null;
    super.onDestroy();
  }
}
