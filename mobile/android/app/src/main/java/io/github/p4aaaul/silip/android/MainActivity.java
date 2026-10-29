package io.github.p4aaaul.silip.android;

import android.app.*;
import android.content.*;
import android.net.Uri;
import android.os.*;
import android.widget.*;

public final class MainActivity extends Activity {
  static MainActivity current;
  static final Handler main = AppRuntimeService.main;
  boolean visible, handledMedia, notificationRequest;
  static final int NOTIFICATIONS = 13;
  AppRuntimeService permissionOwner;
  AppRuntimeService.MediaRequest permissionRequest;

  static final class PermissionBinding extends Binder {
    final AppRuntimeService service;
    final AppRuntimeService.MediaRequest request;

    PermissionBinding(AppRuntimeService service, AppRuntimeService.MediaRequest request) {
      this.service = service;
      this.request = request;
    }

    static PermissionBinding restore(Bundle state) {
      IBinder saved = state.getBinder("permissionOwner");
      if (!(saved instanceof PermissionBinding)) return null;
      PermissionBinding binding = (PermissionBinding) saved;
      // A canceled Go capture still owns its outstanding physical OS result.
      return binding.service == AppRuntimeService.instance
              && binding.service.active == binding.request
              && binding.request.awaitingResult
          ? binding
          : null;
    }
  }

  boolean mediaEntry() {
    return getIntent().getData() != null
        && "silip://media".equals(getIntent().getData().toString());
  }

  boolean wakeEntry() {
    return getIntent().getData() != null && "silip://app".equals(getIntent().getData().toString());
  }

  boolean canConfirmMedia() {
    return !wakeEntry() && (getIntent().getData() == null || mediaEntry());
  }

  @Override
  public void onCreate(Bundle state) {
    super.onCreate(state);
    current = this;
    if (state != null) {
      handledMedia = state.getBoolean("handledMedia");
      notificationRequest = state.getBoolean("notificationRequest");
      PermissionBinding binding = PermissionBinding.restore(state);
      if (binding != null) {
        permissionOwner = binding.service;
        permissionRequest = binding.request;
      }
    }
    Uri requested = getIntent().getData();
    if (requested != null && !wakeEntry() && !mediaEntry()) {
      finish();
      return;
    }
    TextView waiting = new TextView(this);
    waiting.setPadding(24, 48, 24, 24);
    waiting.setText(mediaEntry() ? R.string.media_waiting : R.string.preparing);
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
    state.putBoolean("handledMedia", handledMedia);
    state.putBoolean("notificationRequest", notificationRequest);
    state.putBinder(
        "permissionOwner",
        permissionOwner != null && permissionRequest != null
            ? new PermissionBinding(permissionOwner, permissionRequest)
            : null);
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
    var owner = AppRuntimeService.runtime();
    if (owner == null) return;
    if (wakeEntry()) {
      finish();
      return;
    }
    if (mediaEntry()
        || (getIntent().getData() == null
            && (service.active != null
                || service.preparing != null
                || !service.requests.isEmpty()))) {
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
  }

  void mediaStarted() {
    handledMedia = true;
  }

  void mediaFinished() {
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

  @Override
  public void onRequestPermissionsResult(int request, String[] names, int[] results) {
    super.onRequestPermissionsResult(request, names, results);
    if (request == NOTIFICATIONS) {
      notificationRequest = false;
      startForegroundService(new Intent(this, AppRuntimeService.class));
    } else if (request == AppRuntimeService.AUDIO_PERMISSION && permissionOwner != null) {
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
    if ((mediaEntry() || handledMedia) && AppRuntimeService.instance != null)
      AppRuntimeService.instance.cancelPending();
    finish();
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
    restart.setText(R.string.restart_silip);
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
