package tv.piik.android;

import android.app.*;
import android.content.*;
import android.net.Uri;
import android.os.*;
import android.widget.*;

public final class MainActivity extends Activity {
  static MainActivity current;
  boolean visible, notificationRequest;
  static final int NOTIFICATIONS = 13;
  static final int PROJECTION = 14, SOURCE_AUDIO = 15;
  CapturePlatform capture;
  boolean projectionRequest, audioRequest;
  boolean mediaEntry() { return getIntent().getData() != null && "piik://media".equals(getIntent().getData().toString()); }
  boolean wakeEntry() {
    return getIntent().getData() != null && "piik://app".equals(getIntent().getData().toString());
  }

  @Override
  public void onCreate(Bundle state) {
    super.onCreate(state);
    current = this;
    if (state != null) {
      notificationRequest = state.getBoolean("notificationRequest");
    }
    Uri requested = getIntent().getData();
    if (requested != null && !wakeEntry() && !mediaEntry()) {
      finish();
      return;
    }
    TextView waiting = new TextView(this);
    waiting.setPadding(24, 48, 24, 24);
    waiting.setText(R.string.preparing);
    setContentView(WindowContent.wrap(getWindow(), waiting));
    if (Build.VERSION.SDK_INT >= 33
        && state == null
        && requested == null
        && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
            != android.content.pm.PackageManager.PERMISSION_GRANTED) {
      notificationRequest = true;
      requestPermissions(
          new String[] {android.Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATIONS);
    }
  }

  @Override
  protected void onSaveInstanceState(Bundle state) {
    state.putBoolean("notificationRequest", notificationRequest);
    super.onSaveInstanceState(state);
  }

  @Override
  protected void onStart() {
    super.onStart();
    current = this;
    visible = true;
    // Service foreground readiness precedes reopening even an existing runtime.
    startForegroundService(new Intent(this, AppRuntimeService.class));
  }

  @Override
  protected void onStop() {
    visible = false;
    super.onStop();
  }

  void runtimeAvailable(AppRuntimeService service) {
    if (current != this || !visible || isFinishing() || notificationRequest) return;
    if (service.failure != null) {
      showRuntimeFailure();
      return;
    }
    var owner = service.runtime;
    if (owner == null) return;
    if (mediaEntry()) { captureAvailable(); return; }
    if (wakeEntry()) {
      finish();
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
  }

  @Override
  public void onRequestPermissionsResult(int request, String[] names, int[] results) {
    super.onRequestPermissionsResult(request, names, results);
    if (request == NOTIFICATIONS) {
      notificationRequest = false;
      startForegroundService(new Intent(this, AppRuntimeService.class));
    }
    if (request == SOURCE_AUDIO) audioRequest = false;
    if (request == SOURCE_AUDIO && capture != null) {
      capture.audioPermission(results.length > 0 && results[0] == android.content.pm.PackageManager.PERMISSION_GRANTED);
      captureAvailable();
    }
  }

  void captureAvailable() {
    if (!visible || !mediaEntry()) return;
    AppRuntimeService service = AppRuntimeService.instance;
    if (service == null) return;
    if (capture == null) {
      capture = service.captureRequests.poll();
      if (capture != null) capture.presented(this);
    }
    if (capture == null || capture.isClosed() || projectionRequest || audioRequest) return;
    if (capture.needsAudioPermission()) {
      audioRequest = true;
      requestPermissions(new String[] {android.Manifest.permission.RECORD_AUDIO}, SOURCE_AUDIO);
      return;
    }
    projectionRequest = true;
    startActivityForResult(getSystemService(android.media.projection.MediaProjectionManager.class).createScreenCaptureIntent(), PROJECTION);
  }
  void captureClosed(CapturePlatform owner) {
    if (capture != owner) return;
    if (projectionRequest) finishActivity(PROJECTION);
    capture = null;
    finish();
  }
  @Override protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request != PROJECTION) return;
    projectionRequest = false;
    CapturePlatform owner = capture;
    capture = null;
    if (owner != null) {
      AppRuntimeService service = AppRuntimeService.instance;
      if (service != null) service.captureRequests.remove(owner);
      owner.grant(result, data);
    }
    finish();
  }

  @Override
  protected void onDestroy() {
    if (current == this) current = null;
    if (capture != null && isFinishing()) capture.close();
    super.onDestroy();
  }

  void showRuntimeFailure() {
    LinearLayout failure = new LinearLayout(this);
    failure.setOrientation(LinearLayout.VERTICAL);
    failure.setPadding(24, 48, 24, 24);
    TextView message = new TextView(this);
    message.setText(R.string.runtime_failed);
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
