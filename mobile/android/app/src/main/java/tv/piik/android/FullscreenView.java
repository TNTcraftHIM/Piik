package tv.piik.android;

import android.app.Activity;
import android.app.Dialog;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebChromeClient;

// WebView owns fullscreen content; this window only presents and retires its view.
final class FullscreenView {
  final Activity activity;
  Dialog window;

  FullscreenView(Activity activity) {
    this.activity = activity;
  }

  void show(View content, WebChromeClient.CustomViewCallback callback) {
    if (window != null) {
      callback.onCustomViewHidden();
      return;
    }
    Dialog next = new Dialog(activity, android.R.style.Theme_Material_NoActionBar_Fullscreen);
    window = next;
    next.setContentView(content);
    next.setOnDismissListener(
        ignored -> {
          if (window == next) window = null;
          if (content.getParent() instanceof ViewGroup) {
            ((ViewGroup) content.getParent()).removeView(content);
          }
          callback.onCustomViewHidden();
        });
    next.show();
    next.getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
    next.getWindow()
        .setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
  }

  boolean hide() {
    if (window == null) return false;
    Dialog old = window;
    window = null;
    old.dismiss();
    return true;
  }
}
