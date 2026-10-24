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
    final JSONObject metadata;
    Entry(String name, String codec, MediaCodecInfo.VideoCapabilities video) throws org.json.JSONException {
      this.name = name;
      this.codec = codec;
      int width = Math.min(1920, video.getSupportedWidths().getUpper());
      width -= width % video.getWidthAlignment();
      int height = Math.min(1920, video.getSupportedHeightsFor(width).getUpper());
      height -= height % video.getHeightAlignment();
      double rate = Math.min(60, video.getSupportedFrameRatesFor(width, height).getUpper());
      metadata = new JSONObject().put("name", name).put("codec", codec)
          .put("width", width).put("height", height).put("pixels", (long) width * height)
          .put("macroblocks", Math.min(2073600L, (long) ((width + 15) / 16) * ((height + 15) / 16) * (long) rate))
          .put("fps", Math.min(60, video.getSupportedFrameRates().getUpper()))
          .put("bitrate", Math.min(100000000, video.getBitrateRange().getUpper()));
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
                  entries.add(new Entry(info.getName(), mime.equals("video/avc") ? "h264" : "vp8", capabilities.getVideoCapabilities()));
                  break;
                }
              }
            } catch (IllegalArgumentException | org.json.JSONException unavailable) { /* Continue with the next platform encoder. */ }
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

  static String capabilities() throws Exception {
    JSONArray encoders = new JSONArray();
    for (Entry entry : candidates("auto")) {
      encoders.put(entry.metadata);
    }
    return new JSONObject().put("encoders", encoders).toString();
  }
}
