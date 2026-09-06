#include <gst/app/gstappsink.h>
#include <gst/gst.h>
#include <gst/video/video-event.h>

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/utsname.h>
#include <unistd.h>

#include "portal.h"

enum {
  kCaptureProtocol = 4,
  kMaxPayloadBytes = 4 * 1024 * 1024,
  kAudioFrameBytes = 960 * 2 * 2,
};

typedef enum {
  kPreferResolution,
  kPreferBalanced,
  kPreferFramerate,
} DegradationPreference;

typedef struct {
  guint width;
  guint height;
  guint frame_rate;
  guint bit_rate;
  DegradationPreference preference;
} VideoProfile;

typedef struct {
  char *factory;
  char *name;
  guint bit_rate_divisor;
} EncoderInfo;

typedef struct {
  GMainLoop *loop;
  GstElement *pipeline;
  GstElement *encoder;
  VideoProfile profile;
  const EncoderInfo *encoder_info;
  const char *restore_token;
  GMutex lock;
  char *failure;
  gint stopping;
  gboolean active;
  guint64 last_timestamp;
  GByteArray *audio;
  guint64 audio_timestamp;
} CaptureRun;

static gboolean write_all(const void *data, size_t size) {
  const uint8_t *next = data;
  while (size > 0) {
    ssize_t written = write(STDOUT_FILENO, next, size);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return FALSE;
    next += written;
    size -= (size_t)written;
  }
  return TRUE;
}

static void put_u32_be(uint8_t *output, guint32 value) {
  output[0] = (uint8_t)(value >> 24);
  output[1] = (uint8_t)(value >> 16);
  output[2] = (uint8_t)(value >> 8);
  output[3] = (uint8_t)value;
}

static void put_u64_be(uint8_t *output, guint64 value) {
  for (guint index = 0; index < 8; ++index) {
    output[index] = (uint8_t)(value >> (56 - index * 8));
  }
}

static gboolean write_frame(guint8 kind, guint8 flags, guint64 timestamp,
                            guint64 duration, const guint8 *payload,
                            gsize size) {
  if (payload == NULL || size == 0 || size > kMaxPayloadBytes) return FALSE;
  uint8_t header[28] = {'S', 'M', 'E', 'D', 1, kind, flags, 0};
  put_u64_be(header + 8, timestamp);
  put_u64_be(header + 16, duration);
  put_u32_be(header + 24, (guint32)size);
  return write_all(header, sizeof(header)) && write_all(payload, size);
}

static char *json_string(const char *value) {
  GString *result = g_string_new("\"");
  const unsigned char *next = (const unsigned char *)(value == NULL ? "" : value);
  for (; *next != 0; ++next) {
    switch (*next) {
      case '\"':
        g_string_append(result, "\\\"");
        break;
      case '\\':
        g_string_append(result, "\\\\");
        break;
      case '\b':
        g_string_append(result, "\\b");
        break;
      case '\f':
        g_string_append(result, "\\f");
        break;
      case '\n':
        g_string_append(result, "\\n");
        break;
      case '\r':
        g_string_append(result, "\\r");
        break;
      case '\t':
        g_string_append(result, "\\t");
        break;
      default:
        if (*next < 0x20) {
          g_string_append_printf(result, "\\u%04x", *next);
        } else {
          g_string_append_c(result, (char)*next);
        }
    }
  }
  g_string_append_c(result, '\"');
  return g_string_free(result, FALSE);
}

static gboolean write_status(const char *json) {
  return write_frame(3, 0, 0, 0, (const guint8 *)json, strlen(json));
}

static void encoder_info_free(gpointer value) {
  EncoderInfo *encoder = value;
  if (encoder == NULL) return;
  g_free(encoder->factory);
  g_free(encoder->name);
  g_free(encoder);
}

static gboolean factory_supports_constrained_baseline(
    GstElementFactory *factory) {
  GstCaps *required = gst_caps_from_string(
      "video/x-h264,profile=constrained-baseline");
  gboolean supported = FALSE;
  const GList *templates = gst_element_factory_get_static_pad_templates(factory);
  for (const GList *item = templates; item != NULL; item = item->next) {
    const GstStaticPadTemplate *pad = item->data;
    if (pad->direction != GST_PAD_SRC) continue;
    GstCaps *caps = gst_static_caps_get((GstStaticCaps *)&pad->static_caps);
    supported = gst_caps_can_intersect(caps, required);
    gst_caps_unref(caps);
    if (supported) break;
  }
  gst_caps_unref(required);
  return supported;
}

static guint bitrate_divisor(GstElement *encoder) {
  GParamSpec *property =
      g_object_class_find_property(G_OBJECT_GET_CLASS(encoder), "bitrate");
  if (property == NULL) return 0;
  GType type = G_PARAM_SPEC_VALUE_TYPE(property);
  if (type != G_TYPE_UINT && type != G_TYPE_INT && type != G_TYPE_UINT64 &&
      type != G_TYPE_INT64) {
    return 0;
  }
  const char *blurb = g_param_spec_get_blurb(property);
  char *description = g_ascii_strdown(blurb == NULL ? "" : blurb, -1);
  guint divisor = strstr(description, "kbit") != NULL ||
                          strstr(description, "kbps") != NULL ||
                          strstr(description, "kb/s") != NULL
                      ? 1000
                      : 1;
  g_free(description);
  return divisor;
}

static gint compare_encoders(gconstpointer left, gconstpointer right) {
  const EncoderInfo *a = *(EncoderInfo *const *)left;
  const EncoderInfo *b = *(EncoderInfo *const *)right;
  return g_strcmp0(a->factory, b->factory);
}

static GPtrArray *hardware_encoders(void) {
  GPtrArray *result =
      g_ptr_array_new_with_free_func(encoder_info_free);
  GList *features = gst_registry_get_feature_list(
      gst_registry_get(), GST_TYPE_ELEMENT_FACTORY);
  for (GList *item = features; item != NULL; item = item->next) {
    GstElementFactory *factory = GST_ELEMENT_FACTORY(item->data);
    const char *classification =
        gst_element_factory_get_metadata(factory, GST_ELEMENT_METADATA_KLASS);
    if (classification == NULL || strstr(classification, "Encoder") == NULL ||
        strstr(classification, "Video") == NULL ||
        strstr(classification, "Hardware") == NULL ||
        !factory_supports_constrained_baseline(factory)) {
      continue;
    }
    GstElement *element = gst_element_factory_create(factory, NULL);
    if (element == NULL) continue;
    guint divisor = bitrate_divisor(element);
    gst_object_unref(element);
    if (divisor == 0) continue;
    const char *factory_name = gst_plugin_feature_get_name(GST_PLUGIN_FEATURE(factory));
    const char *long_name = gst_element_factory_get_metadata(
        factory, GST_ELEMENT_METADATA_LONGNAME);
    EncoderInfo *encoder = g_new0(EncoderInfo, 1);
    encoder->factory = g_strdup(factory_name);
    encoder->name = g_strdup(long_name == NULL ? factory_name : long_name);
    encoder->bit_rate_divisor = divisor;
    g_ptr_array_add(result, encoder);
  }
  gst_plugin_feature_list_free(features);
  g_ptr_array_sort(result, compare_encoders);
  return result;
}

static gboolean has_factory(const char *name) {
  GstElementFactory *factory = gst_element_factory_find(name);
  if (factory == NULL) return FALSE;
  gst_object_unref(factory);
  return TRUE;
}

static gboolean video_stack_available(void) {
  const char *required[] = {"pipewiresrc", "queue", "videoconvert",
                            "videoscale", "videorate", "h264parse",
                            "appsink"};
  for (guint index = 0; index < G_N_ELEMENTS(required); ++index) {
    if (!has_factory(required[index])) return FALSE;
  }
  return screener_portal_available();
}

static gboolean audio_stack_available(void) {
  const char *required[] = {"pulsesrc", "queue", "audioconvert",
                            "audioresample", "appsink"};
  for (guint index = 0; index < G_N_ELEMENTS(required); ++index) {
    if (!has_factory(required[index])) return FALSE;
  }
  return TRUE;
}

static int write_probe(void) {
  GPtrArray *encoders = hardware_encoders();
  struct utsname system = {0};
  uname(&system);
  char *build = json_string(system.release[0] == '\0' ? "linux" : system.release);
  gboolean video = video_stack_available();
  gboolean audio = audio_stack_available();
  GString *json = g_string_new(NULL);
  g_string_append_printf(
      json,
      "{\"protocol\":%d,\"platform\":\"linux\",\"platformBuild\":%s,"
      "\"videoCapture\":%s,\"softwareVP8\":false,\"processAudio\":false,\"systemAudio\":%s,"
      "\"adapters\":[",
      kCaptureProtocol, build, video ? "true" : "false",
      audio ? "true" : "false");
  g_free(build);
  if (encoders->len > 0) {
    g_string_append(json,
                    "{\"index\":0,\"name\":\"GStreamer hardware H.264\","
                    "\"identity\":\"gstreamer-hardware-h264\","
                    "\"hardwareH264\":[");
    for (guint index = 0; index < encoders->len; ++index) {
      const EncoderInfo *encoder = g_ptr_array_index(encoders, index);
      char *name = json_string(encoder->name);
      char *identity = json_string(encoder->factory);
      g_string_append_printf(
          json, "%s{\"index\":%u,\"name\":%s,\"identity\":%s}",
          index == 0 ? "" : ",", index, name, identity);
      g_free(name);
      g_free(identity);
    }
    g_string_append(json, "]}");
  }
  g_string_append(json, "]}");
  gboolean written = write_all(json->str, json->len);
  g_string_free(json, TRUE);
  g_ptr_array_unref(encoders);
  return written ? 0 : 2;
}

static int write_sources(void) {
  GPtrArray *encoders = hardware_encoders();
  gboolean available = video_stack_available() && encoders->len > 0;
  g_ptr_array_unref(encoders);
  const char *json = available
                         ? "[{\"kind\":\"picker\",\"sourceId\":\"1\","
                           "\"title\":\"System screen or window\"}]"
                         : "[]";
  return write_all(json, strlen(json)) ? 0 : 2;
}

static gboolean parse_uint(const char *value, guint minimum, guint maximum,
                           guint *output) {
  if (value == NULL || value[0] == '\0' || value[0] == '-') return FALSE;
  char *end = NULL;
  errno = 0;
  unsigned long parsed = strtoul(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed < minimum ||
      parsed > maximum) {
    return FALSE;
  }
  *output = (guint)parsed;
  return TRUE;
}

static gboolean parse_profile(int count, char **values, VideoProfile *profile,
                              guint *encoder_index) {
  if (count != 23 || strcmp(values[1], "--capture-video") != 0 ||
      strcmp(values[2], "picker") != 0 || strcmp(values[3], "1") != 0 ||
      strcmp(values[4], "0") != 0 || strcmp(values[5], "0") != 0 ||
      strcmp(values[6], "--adapter-index") != 0 ||
      strcmp(values[7], "0") != 0 || strcmp(values[8], "--mft-index") != 0 ||
      strcmp(values[10], "--width") != 0 ||
      strcmp(values[12], "--height") != 0 ||
      strcmp(values[14], "--fps") != 0 ||
      strcmp(values[16], "--bitrate") != 0 ||
      strcmp(values[18], "--preference") != 0 ||
      strcmp(values[20], "--codec") != 0 ||
      (strcmp(values[21], "auto") != 0 && strcmp(values[21], "h264") != 0) ||
      strcmp(values[22], "--protocol-v4") != 0 ||
      !parse_uint(values[9], 0, 63, encoder_index) ||
      !parse_uint(values[11], 1, 16384, &profile->width) ||
      !parse_uint(values[13], 1, 16384, &profile->height) ||
      !parse_uint(values[15], 15, 60, &profile->frame_rate) ||
      !parse_uint(values[17], 2000000, 12000000, &profile->bit_rate)) {
    return FALSE;
  }
  gboolean resolution =
      (profile->width == 854 && profile->height == 480) ||
      (profile->width == 1280 && profile->height == 720) ||
      (profile->width == 1920 && profile->height == 1080) ||
      (profile->width == 2560 && profile->height == 1440);
  if (!resolution) return FALSE;
  if (strcmp(values[19], "maintain-resolution") == 0) {
    profile->preference = kPreferResolution;
  } else if (strcmp(values[19], "balanced") == 0) {
    profile->preference = kPreferBalanced;
  } else if (strcmp(values[19], "maintain-framerate") == 0) {
    profile->preference = kPreferFramerate;
  } else {
    return FALSE;
  }
  return TRUE;
}

static gboolean set_numeric_property(GObject *object, const char *name,
                                     guint64 value) {
  GParamSpec *property =
      g_object_class_find_property(G_OBJECT_GET_CLASS(object), name);
  if (property == NULL || !(property->flags & G_PARAM_WRITABLE)) return FALSE;
  GType type = G_PARAM_SPEC_VALUE_TYPE(property);
  if (type == G_TYPE_UINT) {
    g_object_set(object, name, (guint)value, NULL);
  } else if (type == G_TYPE_INT) {
    g_object_set(object, name, (gint)value, NULL);
  } else if (type == G_TYPE_UINT64) {
    g_object_set(object, name, value, NULL);
  } else if (type == G_TYPE_INT64) {
    g_object_set(object, name, (gint64)value, NULL);
  } else {
    return FALSE;
  }
  return TRUE;
}

static void set_optional_boolean(GObject *object, const char *name,
                                 gboolean value) {
  GParamSpec *property =
      g_object_class_find_property(G_OBJECT_GET_CLASS(object), name);
  if (property != NULL && G_PARAM_SPEC_VALUE_TYPE(property) == G_TYPE_BOOLEAN &&
      (property->flags & G_PARAM_WRITABLE)) {
    g_object_set(object, name, value, NULL);
  }
}

static void set_optional_enum(GObject *object, const char *name,
                              const char *nick) {
  GParamSpec *property =
      g_object_class_find_property(G_OBJECT_GET_CLASS(object), name);
  if (property == NULL || !G_IS_PARAM_SPEC_ENUM(property) ||
      !(property->flags & G_PARAM_WRITABLE)) {
    return;
  }
  GEnumClass *values = g_type_class_ref(G_PARAM_SPEC_VALUE_TYPE(property));
  GEnumValue *selected = g_enum_get_value_by_nick(values, nick);
  if (selected != NULL) g_object_set(object, name, selected->value, NULL);
  g_type_class_unref(values);
}

static gboolean configure_encoder(CaptureRun *run) {
  guint64 bitrate =
      run->profile.bit_rate / run->encoder_info->bit_rate_divisor;
  if (!set_numeric_property(G_OBJECT(run->encoder), "bitrate", bitrate)) {
    return FALSE;
  }
  set_numeric_property(G_OBJECT(run->encoder), "key-int-max",
                       run->profile.frame_rate * 2);
  set_numeric_property(G_OBJECT(run->encoder), "b-frames", 0);
  set_numeric_property(G_OBJECT(run->encoder), "ref-frames", 1);
  set_optional_boolean(G_OBJECT(run->encoder), "cabac", FALSE);
  set_optional_boolean(G_OBJECT(run->encoder), "aud", TRUE);
  set_optional_boolean(G_OBJECT(run->encoder), "zerolatency", TRUE);
  set_optional_enum(G_OBJECT(run->encoder), "rate-control", "cbr");
  guint usage = run->profile.preference == kPreferResolution
                    ? 1
                    : run->profile.preference == kPreferFramerate ? 7 : 4;
  set_numeric_property(G_OBJECT(run->encoder), "target-usage", usage);
  return TRUE;
}

static gboolean supported_level(guint8 level) {
  const guint8 levels[] = {0x1e, 0x1f, 0x20, 0x28,
                           0x29, 0x2a, 0x32, 0x33};
  for (guint index = 0; index < G_N_ELEMENTS(levels); ++index) {
    if (levels[index] == level) return TRUE;
  }
  return FALSE;
}

typedef struct {
  gboolean sps;
  gboolean pps;
  gboolean idr;
  char profile_level_id[7];
} NalSummary;

static gsize start_code(const guint8 *data, gsize size, gsize offset,
                        gsize *length) {
  for (gsize index = offset; index + 3 <= size; ++index) {
    if (data[index] != 0 || data[index + 1] != 0) continue;
    if (data[index + 2] == 1) {
      *length = 3;
      return index;
    }
    if (index + 4 <= size && data[index + 2] == 0 && data[index + 3] == 1) {
      *length = 4;
      return index;
    }
  }
  return size;
}

static NalSummary inspect_h264(const guint8 *data, gsize size) {
  NalSummary summary = {0};
  gsize prefix = 0;
  gsize current = start_code(data, size, 0, &prefix);
  while (current < size) {
    gsize nal = current + prefix;
    gsize next_prefix = 0;
    gsize next = start_code(data, size, nal, &next_prefix);
    if (nal < size) {
      guint8 type = data[nal] & 0x1f;
      summary.sps |= type == 7;
      summary.pps |= type == 8;
      summary.idr |= type == 5;
      if (type == 7 && nal + 3 < size && data[nal + 1] == 0x42 &&
          data[nal + 2] == 0xc0 && supported_level(data[nal + 3])) {
        g_snprintf(summary.profile_level_id, sizeof(summary.profile_level_id),
                   "%02x%02x%02x", data[nal + 1], data[nal + 2],
                   data[nal + 3]);
      }
    }
    current = next;
    prefix = next_prefix;
  }
  return summary;
}

static gboolean quit_loop(gpointer data) {
  CaptureRun *run = data;
  g_main_loop_quit(run->loop);
  return G_SOURCE_REMOVE;
}

static void fail_run(CaptureRun *run, const char *message) {
  g_mutex_lock(&run->lock);
  if (run->failure == NULL) run->failure = g_strdup(message);
  g_mutex_unlock(&run->lock);
  g_main_context_invoke(NULL, quit_loop, run);
}

static gboolean force_key_frame(gpointer data) {
  CaptureRun *run = data;
  if (run->encoder == NULL) return G_SOURCE_REMOVE;
  GstPad *source = gst_element_get_static_pad(run->encoder, "src");
  if (source != NULL) {
    gst_pad_send_event(
        source,
        gst_video_event_new_upstream_force_key_unit(GST_CLOCK_TIME_NONE, TRUE,
                                                     0));
    gst_object_unref(source);
  }
  return G_SOURCE_REMOVE;
}

static gpointer control_input(gpointer data) {
  CaptureRun *run = data;
  guint8 value = 0;
  while (read(STDIN_FILENO, &value, 1) == 1) {
    if (value == 'K') {
      g_main_context_invoke(NULL, force_key_frame, run);
    } else if (value == 'Q' || value == '\n' || value == '\r') {
      g_atomic_int_set(&run->stopping, TRUE);
      g_main_context_invoke(NULL, quit_loop, run);
      return NULL;
    }
  }
  g_atomic_int_set(&run->stopping, TRUE);
  g_main_context_invoke(NULL, quit_loop, run);
  return NULL;
}

static gboolean bus_message(GstBus *bus, GstMessage *message, gpointer data) {
  (void)bus;
  CaptureRun *run = data;
  if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_ERROR) {
    GError *error = NULL;
    char *debug = NULL;
    gst_message_parse_error(message, &error, &debug);
    fail_run(run, error == NULL ? "GStreamer pipeline failed" : error->message);
    g_clear_error(&error);
    g_free(debug);
  } else if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_EOS &&
             !g_atomic_int_get(&run->stopping)) {
    fail_run(run, "GStreamer pipeline ended unexpectedly");
  }
  return G_SOURCE_CONTINUE;
}

static GstFlowReturn video_sample(GstAppSink *sink, gpointer data) {
  CaptureRun *run = data;
  GstSample *sample = gst_app_sink_pull_sample(sink);
  if (sample == NULL) return GST_FLOW_EOS;
  GstBuffer *buffer = gst_sample_get_buffer(sample);
  GstMapInfo mapped = GST_MAP_INFO_INIT;
  if (buffer == NULL || !gst_buffer_map(buffer, &mapped, GST_MAP_READ) ||
      mapped.size == 0 || mapped.size > kMaxPayloadBytes) {
    if (buffer != NULL && mapped.data != NULL) gst_buffer_unmap(buffer, &mapped);
    gst_sample_unref(sample);
    fail_run(run, "GStreamer returned an invalid H.264 access unit");
    return GST_FLOW_ERROR;
  }
  gboolean key_frame = !GST_BUFFER_FLAG_IS_SET(buffer, GST_BUFFER_FLAG_DELTA_UNIT);
  NalSummary nal = inspect_h264(mapped.data, mapped.size);
  if (!run->active &&
      (!key_frame || !nal.sps || !nal.pps || !nal.idr ||
       nal.profile_level_id[0] == '\0')) {
    gst_buffer_unmap(buffer, &mapped);
    gst_sample_unref(sample);
    g_main_context_invoke(NULL, force_key_frame, run);
    return GST_FLOW_OK;
  }
  guint64 duration = GST_BUFFER_DURATION_IS_VALID(buffer)
                         ? GST_BUFFER_DURATION(buffer) / 100
                         : 10000000ULL / run->profile.frame_rate;
  guint64 timestamp = GST_BUFFER_PTS_IS_VALID(buffer)
                          ? GST_BUFFER_PTS(buffer) / 100
                          : run->last_timestamp + duration;
  if (run->last_timestamp != 0 && timestamp <= run->last_timestamp) {
    timestamp = run->last_timestamp + duration;
  }
  run->last_timestamp = timestamp;
  gboolean written = write_frame(2, key_frame ? 1 : 0, timestamp, duration,
                                  mapped.data, mapped.size);
  gst_buffer_unmap(buffer, &mapped);
  gst_sample_unref(sample);
  if (!written) {
    fail_run(run, "native media output closed");
    return GST_FLOW_ERROR;
  }
  if (!run->active) {
    char *token = json_string(run->restore_token);
    char *status = g_strdup_printf(
        "{\"state\":\"active\",\"codec\":\"h264\",\"hardwareOnly\":true,"
        "\"profileLevelId\":\"%s\",\"width\":%u,\"height\":%u,"
        "\"fps\":%u,\"restoreToken\":%s}",
        nal.profile_level_id, run->profile.width, run->profile.height,
        run->profile.frame_rate, token);
    g_free(token);
    run->active = write_status(status);
    g_free(status);
    if (!run->active) {
      fail_run(run, "native media output closed");
      return GST_FLOW_ERROR;
    }
  }
  return GST_FLOW_OK;
}

static GstFlowReturn audio_sample(GstAppSink *sink, gpointer data) {
  CaptureRun *run = data;
  GstSample *sample = gst_app_sink_pull_sample(sink);
  if (sample == NULL) return GST_FLOW_EOS;
  GstBuffer *buffer = gst_sample_get_buffer(sample);
  GstMapInfo mapped = GST_MAP_INFO_INIT;
  if (buffer == NULL || !gst_buffer_map(buffer, &mapped, GST_MAP_READ)) {
    gst_sample_unref(sample);
    fail_run(run, "GStreamer returned invalid PCM audio");
    return GST_FLOW_ERROR;
  }
  if (run->audio->len == 0 && GST_BUFFER_PTS_IS_VALID(buffer)) {
    run->audio_timestamp = GST_BUFFER_PTS(buffer) / 100;
  }
  if (!run->active) {
    run->active = write_status("{\"state\":\"active\",\"audio\":true}");
    if (!run->active) {
      gst_buffer_unmap(buffer, &mapped);
      gst_sample_unref(sample);
      fail_run(run, "native audio output closed");
      return GST_FLOW_ERROR;
    }
  }
  g_byte_array_append(run->audio, mapped.data, mapped.size);
  gst_buffer_unmap(buffer, &mapped);
  gst_sample_unref(sample);
  while (run->audio->len >= kAudioFrameBytes) {
    if (!write_frame(1, 0, run->audio_timestamp, 200000,
                     run->audio->data, kAudioFrameBytes)) {
      fail_run(run, "native audio output closed");
      return GST_FLOW_ERROR;
    }
    run->audio_timestamp += 200000;
    g_byte_array_remove_range(run->audio, 0, kAudioFrameBytes);
  }
  return GST_FLOW_OK;
}

static int run_pipeline(CaptureRun *run, GCallback sample_callback,
                        const char *starting_status) {
  GstBus *bus = gst_element_get_bus(run->pipeline);
  guint bus_watch = gst_bus_add_watch(bus, bus_message, run);
  gst_object_unref(bus);
  GstElement *output = gst_bin_get_by_name(GST_BIN(run->pipeline), "output");
  if (output == NULL) return 2;
  g_signal_connect(output, "new-sample", sample_callback, run);
  gst_object_unref(output);
  if (starting_status != NULL && !write_status(starting_status)) return 2;
  GstStateChangeReturn state =
      gst_element_set_state(run->pipeline, GST_STATE_PLAYING);
  if (state == GST_STATE_CHANGE_FAILURE) return 2;
  if (gst_element_get_state(run->pipeline, NULL, NULL, 5 * GST_SECOND) ==
      GST_STATE_CHANGE_FAILURE) {
    return 2;
  }
  g_thread_unref(g_thread_new("screener-control", control_input, run));
  g_main_loop_run(run->loop);
  gst_element_set_state(run->pipeline, GST_STATE_NULL);
  g_source_remove(bus_watch);
  g_mutex_lock(&run->lock);
  char *failure = g_strdup(run->failure);
  g_mutex_unlock(&run->lock);
  if (failure != NULL) {
    fprintf(stderr, "Screener capture unavailable: %s\n", failure);
    g_free(failure);
    return 2;
  }
  return 0;
}

static int capture_video(int count, char **values) {
  VideoProfile profile = {0};
  guint encoder_index = 0;
  if (!parse_profile(count, values, &profile, &encoder_index)) return 2;
  GPtrArray *encoders = hardware_encoders();
  if (!video_stack_available() || encoder_index >= encoders->len) {
    g_ptr_array_unref(encoders);
    return 2;
  }
  const EncoderInfo *encoder_info = g_ptr_array_index(encoders, encoder_index);
  GError *error = NULL;
  ScreenerPortalCapture portal = {.pipewire_fd = -1};
  if (!screener_portal_capture_open(
          g_getenv("SCREENER_XDP_RESTORE_TOKEN"), &portal, &error)) {
    fprintf(stderr, "Screener capture unavailable: %s\n",
            error == NULL ? "screen selection failed" : error->message);
    g_clear_error(&error);
    g_ptr_array_unref(encoders);
    return 2;
  }

  char *pipeline_text = g_strdup_printf(
      "pipewiresrc name=source fd=%d target-object=%s do-timestamp=true ! "
      "queue max-size-buffers=2 max-size-bytes=0 max-size-time=0 "
      "leaky=downstream ! videoconvert ! videoscale ! videorate ! "
      "video/x-raw,format=NV12,width=%u,height=%u,framerate=%u/1 ! "
      "%s name=encoder ! video/x-h264,profile=constrained-baseline ! "
      "h264parse config-interval=-1 ! "
      "video/x-h264,stream-format=byte-stream,alignment=au ! "
      "appsink name=output emit-signals=true sync=false max-buffers=2 drop=true",
      portal.pipewire_fd, portal.target_object, profile.width, profile.height,
      profile.frame_rate, encoder_info->factory);
  GstElement *pipeline = gst_parse_launch(pipeline_text, &error);
  g_free(pipeline_text);
  if (pipeline == NULL || error != NULL) {
    fprintf(stderr, "Screener capture unavailable: %s\n",
            error == NULL ? "video pipeline failed" : error->message);
    g_clear_error(&error);
    if (pipeline != NULL) gst_object_unref(pipeline);
    screener_portal_capture_close(&portal);
    g_ptr_array_unref(encoders);
    return 2;
  }
  CaptureRun run = {
      .loop = g_main_loop_new(NULL, FALSE),
      .pipeline = pipeline,
      .profile = profile,
      .encoder_info = encoder_info,
      .restore_token = portal.restore_token,
  };
  g_mutex_init(&run.lock);
  run.encoder = gst_bin_get_by_name(GST_BIN(pipeline), "encoder");
  GstElement *source = gst_bin_get_by_name(GST_BIN(pipeline), "source");
  if (source != NULL) {
    set_optional_boolean(G_OBJECT(source), "resend-last", TRUE);
    set_numeric_property(G_OBJECT(source), "keepalive-time",
                         MAX(1, 1000 / profile.frame_rate));
    gst_object_unref(source);
  }
  if (run.encoder == NULL || !configure_encoder(&run)) {
    fprintf(stderr, "Screener capture unavailable: hardware encoder is incompatible\n");
    if (run.encoder != NULL) gst_object_unref(run.encoder);
    g_main_loop_unref(run.loop);
    g_mutex_clear(&run.lock);
    gst_object_unref(pipeline);
    screener_portal_capture_close(&portal);
    g_ptr_array_unref(encoders);
    return 2;
  }
  char *adapter_name = json_string("GStreamer hardware H.264");
  char *encoder_name = json_string(encoder_info->name);
  char *encoder_identity = json_string(encoder_info->factory);
  char *starting = g_strdup_printf(
      "{\"state\":\"starting\",\"codec\":\"h264\",\"hardwareOnly\":true,"
      "\"adapterIndex\":0,\"adapterName\":%s,"
      "\"adapterIdentity\":\"gstreamer-hardware-h264\","
      "\"encoderIndex\":%u,\"encoderName\":%s,"
      "\"encoderIdentity\":%s}",
      adapter_name, encoder_index, encoder_name, encoder_identity);
  g_free(adapter_name);
  g_free(encoder_name);
  g_free(encoder_identity);
  int result = run_pipeline(&run, G_CALLBACK(video_sample), starting);
  g_free(starting);
  gst_object_unref(run.encoder);
  g_free(run.failure);
  g_main_loop_unref(run.loop);
  g_mutex_clear(&run.lock);
  gst_object_unref(pipeline);
  screener_portal_capture_close(&portal);
  g_ptr_array_unref(encoders);
  return result;
}

static int capture_audio(int count, char **values) {
  if (count != 5 || strcmp(values[1], "--capture-audio") != 0 ||
      (strcmp(values[2], "picker") != 0 &&
       strcmp(values[2], "display") != 0) ||
      strcmp(values[3], "0") != 0 ||
      strcmp(values[4], "0") != 0 || !audio_stack_available()) {
    return 2;
  }
  GError *error = NULL;
  GstElement *pipeline = gst_parse_launch(
      "pulsesrc device=@DEFAULT_MONITOR@ do-timestamp=true ! "
      "queue max-size-buffers=4 max-size-bytes=0 max-size-time=0 "
      "leaky=downstream ! audioconvert ! audioresample ! "
      "audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved ! "
      "appsink name=output emit-signals=true sync=false max-buffers=4 drop=true",
      &error);
  if (pipeline == NULL || error != NULL) {
    g_clear_error(&error);
    if (pipeline != NULL) gst_object_unref(pipeline);
    return 2;
  }
  CaptureRun run = {
      .loop = g_main_loop_new(NULL, FALSE),
      .pipeline = pipeline,
      .audio = g_byte_array_new(),
  };
  g_mutex_init(&run.lock);
  int result = run_pipeline(&run, G_CALLBACK(audio_sample), NULL);
  g_byte_array_unref(run.audio);
  g_free(run.failure);
  g_main_loop_unref(run.loop);
  g_mutex_clear(&run.lock);
  gst_object_unref(pipeline);
  return result;
}

int main(int argc, char **argv) {
  gst_init(&argc, &argv);
  if (argc == 2 && strcmp(argv[1], "--probe") == 0) return write_probe();
  if (argc == 2 && strcmp(argv[1], "--list") == 0) return write_sources();
  if (argc > 1 && strcmp(argv[1], "--capture-video") == 0) {
    return capture_video(argc, argv);
  }
  if (argc > 1 && strcmp(argv[1], "--capture-audio") == 0) {
    return capture_audio(argc, argv);
  }
  fprintf(stderr, "Screener capture unavailable: unsupported command\n");
  return 2;
}
