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
    if (requested != null && !wakeEntry()) {
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
  }

  @Override
  protected void onDestroy() {
    if (current == this) current = null;
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
