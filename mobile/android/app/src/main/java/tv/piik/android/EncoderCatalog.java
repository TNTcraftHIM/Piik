package tv.piik.android;

import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** Android's available Surface encoders; selection never substitutes an explicit codec. */
final class EncoderCatalog {
  static final class Entry {
    final String name, codec;
    Entry(String name, String codec) {
      this.name = name;
      this.codec = codec;
    }
  }

  private static List<Entry> entries;

  static synchronized List<Entry> candidates(String requested) {
    if (entries == null) {
      entries = new ArrayList<>();
      for (String mime : new String[] {"video/avc", "video/x-vnd.on2.vp8"}) {
        for (MediaCodecInfo info : new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos()) {
          if (!info.isEncoder() || (mime.equals("video/avc") && !info.isHardwareAccelerated())) continue;
          for (String type : info.getSupportedTypes()) {
            if (!type.equalsIgnoreCase(mime)) continue;
            try {
              MediaCodecInfo.CodecCapabilities capabilities = info.getCapabilitiesForType(type);
              for (int color : capabilities.colorFormats) {
                if (color == MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface) {
                  entries.add(new Entry(info.getName(), mime.equals("video/avc") ? "h264" : "vp8"));
                  break;
                }
              }
            } catch (IllegalArgumentException unavailable) { /* Continue with the next platform encoder. */ }
          }
        }
      }
    }
    List<Entry> selected = new ArrayList<>();
    for (Entry entry : entries) if (requested.equals("auto") || requested.equals(entry.codec)) selected.add(entry);
    return selected;
  }

  static long attemptDeadline(long now, long deadline, boolean hasNext) {
    return hasNext ? Math.min(deadline, now + 2000) : deadline;
  }

  static String capabilities() throws org.json.JSONException {
    JSONArray encoders = new JSONArray();
    for (Entry entry : candidates("auto")) {
      encoders.put(new JSONObject().put("name", entry.name).put("codec", entry.codec));
    }
    return new JSONObject().put("platform", "android").put("provider", "Android MediaCodec")
        .put("systemAudio", encoders.length() > 0).put("encoders", encoders).toString();
  }
}
