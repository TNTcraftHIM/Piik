package tv.piik.android;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import org.json.JSONArray;
import org.json.JSONObject;

final class MicrophoneDevices {
  static String list(Context context) throws Exception {
    JSONArray result = new JSONArray();
    for (AudioDeviceInfo device :
        context.getSystemService(AudioManager.class).getDevices(AudioManager.GET_DEVICES_INPUTS)) {
      result.put(
          new JSONObject()
              .put("id", Integer.toString(device.getId()))
              .put("label", device.getProductName().toString()));
    }
    return result.toString();
  }

  static AudioDeviceInfo selected(Context context, String id) {
    if (id.isEmpty()) return null; // Empty is the existing system-default choice.
    for (AudioDeviceInfo device :
        context.getSystemService(AudioManager.class).getDevices(AudioManager.GET_DEVICES_INPUTS)) {
      if (Integer.toString(device.getId()).equals(id)) return device;
    }
    throw new IllegalArgumentException("The selected microphone is unavailable");
  }
}
