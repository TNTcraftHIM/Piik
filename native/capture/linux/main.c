#include <gst/app/gstappsink.h>
#include <gst/app/gstappsrc.h>
#include <gst/gst.h>
#include <gst/video/video-event.h>
#include <glib-unix.h>

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/utsname.h>
#include <unistd.h>

#include "portal.h"

enum {
  kCaptureProtocol = 7,
  kMaxOutputs = 6,
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

typedef struct CaptureRun CaptureRun;

typedef struct {
  CaptureRun *run;
  GstElement *encoder;
  GstElement *branch;
  GstElement *gate;
  VideoProfile profile;
  guint layer;
  gboolean enabled;
  gboolean failed;
  gboolean decodable;
  guint64 key_requested;
  guint64 key_sent;
  guint64 key_acknowledged;
  GstClockTime key_timestamp;
  GstClockTime activation_timestamp;
} VideoOutput;

struct CaptureRun {
  GMainLoop *loop;
  GstElement *pipeline;
  GstElement *encoded_source;
  VideoProfile profile;
  VideoOutput outputs[kMaxOutputs];
  guint output_count;
  guint original_output;
  const EncoderInfo *encoder_info;
  const char *restore_token;
  GMutex lock;
  char *failure;
  gint stopping;
  gboolean active;
  GstClockTime last_input_timestamp;
  guint8 input_header[32];
  guint input_header_length;
  GByteArray *input_payload;
  guint input_size;
  guint64 encoded_timestamp;
  gboolean encoded_started;
  GByteArray *audio;
  guint64 audio_timestamp;
};

static GMutex output_lock;

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

static guint64 read_be(const guint8 *input, guint count) {
  guint64 value = 0;
  for (guint index = 0; index < count; ++index) value = (value << 8) | input[index];
  return value;
}

static gboolean write_frame(guint8 kind, guint8 flags, guint8 layer,
                            guint width, guint height, guint64 timestamp,
                            guint64 duration, const guint8 *payload, gsize size) {
  if ((kind != 5 && (payload == NULL || size == 0)) ||
      size > ((kind == 3 || kind == 6) ? 1024 * 1024 : kMaxPayloadBytes)) return FALSE;
  uint8_t header[32] = {'S', 'M', 'E', 'D', 2, kind, flags, layer};
  put_u64_be(header + 8, timestamp);
  put_u64_be(header + 16, duration);
  header[24] = (guint8)(width >> 8);
  header[25] = (guint8)width;
  header[26] = (guint8)(height >> 8);
  header[27] = (guint8)height;
  put_u32_be(header + 28, (guint32)size);
  g_mutex_lock(&output_lock);
  gboolean written = write_all(header, sizeof(header)) && write_all(payload, size);
  g_mutex_unlock(&output_lock);
  return written;
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
  return write_frame(3, 0, 0, 0, 0, 0, 0, (const guint8 *)json, strlen(json));
}

static char *output_profiles_json(const CaptureRun *run) {
  GString *json = g_string_new("[");
  for (guint index = 0; index < run->output_count; ++index) {
    const VideoProfile *profile = &run->outputs[index].profile;
    g_string_append_printf(json,
        "%s{\"width\":%u,\"height\":%u,\"fps\":%u,\"bitrate\":%u}",
        index == 0 ? "" : ",", profile->width, profile->height,
        profile->frame_rate, profile->bit_rate);
  }
  g_string_append_c(json, ']');
  return g_string_free(json, FALSE);
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
  if (property == NULL || !(property->flags & G_PARAM_WRITABLE) ||
      !(property->flags & GST_PARAM_MUTABLE_PLAYING)) return 0;
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
  const char *required[] = {"pipewiresrc", "queue", "tee", "videoconvert",
                            "videoscale", "videorate", "h264parse",
                            "appsink"};
  for (guint index = 0; index < G_N_ELEMENTS(required); ++index) {
    if (!has_factory(required[index])) return FALSE;
  }
  return piik_portal_available();
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
      "\"videoCapture\":%s,\"softwareVP8\":false,\"processAudio\":false,\"systemAudio\":%s,\"microphone\":%s,"
      "\"adapters\":[",
      kCaptureProtocol, build, video ? "true" : "false",
      audio ? "true" : "false", audio ? "true" : "false");
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

static gboolean parse_outputs(int count, char **values, guint start, CaptureRun *run) {
  if (count <= (int)start || (count - (int)start) % 5 != 0 ||
      (count - (int)start) / 5 > kMaxOutputs) return FALSE;
  run->output_count = (guint)(count - (int)start) / 5;
  for (guint index = 0; index < run->output_count; ++index) {
    guint offset = start + index * 5;
    VideoOutput *output = &run->outputs[index];
    output->run = run;
    output->layer = index;
    output->enabled = strcmp(values[1], "--capture-video") == 0 && index < 2;
    output->key_requested = 1;
    output->key_timestamp = GST_CLOCK_TIME_NONE;
    output->activation_timestamp = GST_CLOCK_TIME_NONE;
    output->profile.preference = run->profile.preference;
    if (strcmp(values[offset], "--output") != 0 ||
        !parse_uint(values[offset + 1], 2, 2560, &output->profile.width) ||
        !parse_uint(values[offset + 2], 2, 1440, &output->profile.height) ||
        !parse_uint(values[offset + 3], 1, 60, &output->profile.frame_rate) ||
        !parse_uint(values[offset + 4], 1000, 12000000, &output->profile.bit_rate) ||
        output->profile.width % 2 != 0 || output->profile.height % 2 != 0) return FALSE;
  }
  return TRUE;
}

static gboolean parse_preference(const char *value, VideoProfile *profile) {
  if (strcmp(value, "maintain-resolution") == 0) profile->preference = kPreferResolution;
  else if (strcmp(value, "balanced") == 0) profile->preference = kPreferBalanced;
  else if (strcmp(value, "maintain-framerate") == 0) profile->preference = kPreferFramerate;
  else return FALSE;
  return TRUE;
}

static gboolean parse_profile(int count, char **values, CaptureRun *run,
                              guint *encoder_index) {
  VideoProfile *profile = &run->profile;
  if (count >= 16 && strcmp(values[1], "--encoded-video") == 0) {
    if (strcmp(values[2], "--codec") != 0 || strcmp(values[3], "h264") != 0 ||
        strcmp(values[4], "--adapter-index") != 0 || strcmp(values[5], "0") != 0 ||
        strcmp(values[6], "--mft-index") != 0 || !parse_uint(values[7], 0, 63, encoder_index) ||
        strcmp(values[8], "--preference") != 0 || !parse_preference(values[9], profile) ||
        strcmp(values[10], "--protocol-v7") != 0 || !parse_outputs(count, values, 11, run)) return FALSE;
    for (guint index = 0; index < run->output_count; ++index) {
      const VideoProfile *output = &run->outputs[index].profile;
      profile->width = MAX(profile->width, output->width);
      profile->height = MAX(profile->height, output->height);
      profile->frame_rate = MAX(profile->frame_rate, output->frame_rate);
      profile->bit_rate = MAX(profile->bit_rate, output->bit_rate);
    }
    run->original_output = 0;
    return TRUE;
  }
  if (count < 28 || (count - 23) % 5 != 0 ||
      (count - 23) / 5 > kMaxOutputs ||
      strcmp(values[1], "--capture-video") != 0 ||
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
      strcmp(values[22], "--protocol-v7") != 0 ||
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
  if (!parse_preference(values[19], profile) || !parse_outputs(count, values, 23, run)) return FALSE;
  run->original_output = MIN(1, run->output_count - 1);
  const VideoProfile *original = &run->outputs[run->original_output].profile;
  if (original->width != profile->width || original->height != profile->height ||
      original->frame_rate != profile->frame_rate ||
      original->bit_rate != profile->bit_rate) return FALSE;
  for (guint index = 0; index < run->output_count; ++index) {
    const VideoProfile *output = &run->outputs[index].profile;
    if (output->width > profile->width || output->height > profile->height ||
        output->frame_rate > profile->frame_rate || output->bit_rate > profile->bit_rate) return FALSE;
  }
  return TRUE;
}

static gboolean set_numeric_property(GObject *object, const char *name,
                                     guint64 value) {
  GParamSpec *property =
      g_object_class_find_property(G_OBJECT_GET_CLASS(object), name);
  if (property == NULL || !(property->flags & G_PARAM_WRITABLE)) return FALSE;
  GType type = G_PARAM_SPEC_VALUE_TYPE(property);
  GValue setting = G_VALUE_INIT;
  g_value_init(&setting, type);
  if (type == G_TYPE_UINT) {
    g_value_set_uint(&setting, (guint)value);
  } else if (type == G_TYPE_INT) {
    g_value_set_int(&setting, (gint)value);
  } else if (type == G_TYPE_UINT64) {
    g_value_set_uint64(&setting, value);
  } else if (type == G_TYPE_INT64) {
    g_value_set_int64(&setting, (gint64)value);
  } else {
    g_value_unset(&setting);
    return FALSE;
  }
  if (g_param_value_validate(property, &setting)) {
    g_value_unset(&setting);
    return FALSE;
  }
  g_object_set_property(object, name, &setting);
  g_value_unset(&setting);
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

static gboolean configure_encoder(VideoOutput *output) {
  CaptureRun *run = output->run;
  guint64 bitrate =
      output->profile.bit_rate / run->encoder_info->bit_rate_divisor;
  if (!set_numeric_property(G_OBJECT(output->encoder), "bitrate", bitrate)) {
    return FALSE;
  }
  set_numeric_property(G_OBJECT(output->encoder), "key-int-max",
                       output->profile.frame_rate * 2);
  set_numeric_property(G_OBJECT(output->encoder), "b-frames", 0);
  set_numeric_property(G_OBJECT(output->encoder), "ref-frames", 1);
  set_optional_boolean(G_OBJECT(output->encoder), "cabac", FALSE);
  set_optional_boolean(G_OBJECT(output->encoder), "aud", TRUE);
  set_optional_boolean(G_OBJECT(output->encoder), "zerolatency", TRUE);
  set_optional_enum(G_OBJECT(output->encoder), "rate-control", "cbr");
  guint usage = output->profile.preference == kPreferResolution
                    ? 1
                    : run->profile.preference == kPreferFramerate ? 7 : 4;
  set_numeric_property(G_OBJECT(output->encoder), "target-usage", usage);
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
  gboolean first = run->failure == NULL;
  if (first) run->failure = g_strdup(message);
  g_mutex_unlock(&run->lock);
  if (first) g_main_context_invoke(NULL, quit_loop, run);
}

static void fail_output(VideoOutput *output, const char *message) {
  // Streaming callbacks report to the bus; only its main-context owner retires
  // branches. Stopping an encoder from its own streaming thread can deadlock.
  GError *error = g_error_new_literal(GST_STREAM_ERROR, GST_STREAM_ERROR_ENCODE, message);
  gst_element_post_message(output->encoder,
      gst_message_new_error(GST_OBJECT(output->encoder), error, NULL));
  g_error_free(error);
}

static GstFlowReturn output_chain(GstPad *pad, GstObject *parent, GstBuffer *buffer) {
  VideoOutput *output = g_object_get_data(G_OBJECT(pad), "piik-output");
  GstFlowReturn flow = gst_proxy_pad_chain_default(pad, parent, buffer);
  if (flow >= GST_FLOW_OK) return flow;
  // Bus errors arrive asynchronously. Contain the queue's failed flow here,
  // before it reaches the shared tee, even when no encoder error was posted.
  gboolean dropping = FALSE;
  g_object_get(output->gate, "drop", &dropping, NULL);
  g_object_set(output->gate, "drop", TRUE, NULL);
  if (!dropping && !g_atomic_int_get(&output->run->stopping)) {
    char *message = g_strdup_printf("GStreamer output stopped: %s", gst_flow_get_name(flow));
    fail_output(output, message);
    g_free(message);
  }
  return GST_FLOW_OK;
}

static gboolean isolate_output(VideoOutput *output) {
  GstPad *source = gst_element_get_static_pad(output->gate, "src");
  GstPad *input = source == NULL ? NULL : gst_pad_get_peer(source);
  if (source != NULL) gst_object_unref(source);
  if (input == NULL) return FALSE;
  if (!GST_IS_GHOST_PAD(input)) {
    gst_object_unref(input);
    return FALSE;
  }
  g_object_set_data(G_OBJECT(input), "piik-output", output);
  gst_pad_set_chain_function(input, output_chain);
  gst_object_unref(input);
  g_object_set(output->gate, "drop", TRUE, NULL);
  gst_element_set_locked_state(output->branch, TRUE);
  return TRUE;
}

static gboolean set_output_active(VideoOutput *output, gboolean enabled) {
  CaptureRun *run = output->run;
  if (enabled && output->failed) return TRUE;
  g_mutex_lock(&run->lock);
  if (output->enabled == enabled) {
    g_mutex_unlock(&run->lock);
    return TRUE;
  }
  output->enabled = FALSE;
  output->decodable = FALSE;
  output->activation_timestamp = GST_CLOCK_TIME_NONE;
  output->key_timestamp = GST_CLOCK_TIME_NONE;
  ++output->key_requested;
  g_mutex_unlock(&run->lock);
  // A closed valve isolates the retired branch from the other tee subscribers.
  g_object_set(output->gate, "drop", TRUE, NULL);
  gst_element_set_locked_state(output->branch, !enabled);
  gboolean applied = enabled
      ? gst_element_sync_state_with_parent(output->branch)
      : gst_element_set_state(output->branch, GST_STATE_NULL) != GST_STATE_CHANGE_FAILURE;
  if (!applied) {
    gst_element_set_locked_state(output->branch, TRUE);
    gst_element_set_state(output->branch, GST_STATE_NULL);
    fail_output(output, "GStreamer output could not change state");
    return TRUE;
  }
  g_mutex_lock(&run->lock);
  output->enabled = enabled;
  g_mutex_unlock(&run->lock);
  if (enabled) g_object_set(output->gate, "drop", FALSE, NULL);
  return TRUE;
}

static gboolean apply_control(CaptureRun *run, char *line) {
  char *values[4] = {0};
  guint count = 0;
  g_auto(GStrv) tokens = g_strsplit_set(line, " \t\r", -1);
  for (guint index = 0; tokens[index] != NULL; ++index) {
    char *part = tokens[index];
    if (part[0] == '\0') continue;
    if (count == G_N_ELEMENTS(values)) return FALSE;
    values[count++] = part;
  }
  if (count == 1 && strcmp(values[0], "Q") == 0) {
    g_atomic_int_set(&run->stopping, TRUE);
    g_main_loop_quit(run->loop);
    return TRUE;
  }
  if (run->output_count == 0) return FALSE;
  guint layer = 0;
  if (count == 2 && strcmp(values[0], "K") == 0) {
    gboolean all = strcmp(values[1], "-1") == 0;
    if (!all && !parse_uint(values[1], 0, run->output_count - 1, &layer)) return FALSE;
    g_mutex_lock(&run->lock);
    for (guint index = 0; index < run->output_count; ++index) {
      if (all || index == layer) ++run->outputs[index].key_requested;
    }
    g_mutex_unlock(&run->lock);
    return TRUE;
  }
  if (count == 3 && strcmp(values[0], "A") == 0) {
    guint active = 0;
    if (!parse_uint(values[1], 0, run->output_count - 1, &layer) ||
        !parse_uint(values[2], 0, 1, &active)) return FALSE;
    return set_output_active(&run->outputs[layer], active != 0);
  }
  if (count == 3 && strcmp(values[0], "B") == 0 &&
      parse_uint(values[1], 0, run->output_count - 1, &layer)) {
    VideoOutput *output = &run->outputs[layer];
    guint bitrate = 0;
    if (!parse_uint(values[2], 1000, output->profile.bit_rate, &bitrate)) return FALSE;
    if (output->failed) return TRUE;
    GParamSpec *property = g_object_class_find_property(
        G_OBJECT_GET_CLASS(output->encoder), "bitrate");
    if (property == NULL || !(property->flags & GST_PARAM_MUTABLE_PLAYING) ||
        !set_numeric_property(G_OBJECT(output->encoder), "bitrate",
                              MAX(1, bitrate / run->encoder_info->bit_rate_divisor))) {
      fail_output(output, "hardware encoder cannot apply the live bitrate");
    }
    return TRUE;
  }
  return FALSE;
}

static gboolean valid_input_header(CaptureRun *run) {
  const guint8 *header = run->input_header;
  if (memcmp(header, "SMED", 4) != 0 || header[4] != 2) return FALSE;
  run->input_size = (guint)read_be(header + 28, 4);
  if (header[5] == 7) {
    for (guint index = 6; index < 28; ++index) if (header[index] != 0) return FALSE;
    return run->input_size > 0 && run->input_size <= 64;
  }
  if (header[5] != 2 || run->encoded_source == NULL || header[6] > 1 || header[7] != 0 ||
      run->input_size == 0 || run->input_size > kMaxPayloadBytes) return FALSE;
  guint width = (guint)read_be(header + 24, 2), height = (guint)read_be(header + 26, 2);
  guint64 timestamp = read_be(header + 8, 8), duration = read_be(header + 16, 8);
  return width >= 2 && width <= 2560 && height >= 2 && height <= 1440 &&
         width % 2 == 0 && height % 2 == 0 && duration > 0 &&
         timestamp <= INT64_MAX / 100 && duration <= INT64_MAX / 100;
}

static gboolean apply_input(CaptureRun *run) {
  const guint8 *payload = run->input_payload->data;
  if (run->input_header[5] == 7) {
    for (guint index = 0; index < run->input_size; ++index) if (payload[index] < 32 || payload[index] > 126) return FALSE;
    char command[65];
    memcpy(command, payload, run->input_size);
    command[run->input_size] = '\0';
    return apply_control(run, command);
  }
  NalSummary nal = inspect_h264(payload, run->input_size);
  guint64 timestamp = read_be(run->input_header + 8, 8);
  if ((!run->encoded_started && !(nal.sps && nal.pps && nal.idr)) ||
      (run->encoded_started && timestamp <= run->encoded_timestamp)) return FALSE;
  GstBuffer *buffer = gst_buffer_new_allocate(NULL, run->input_size, NULL);
  if (buffer == NULL) return FALSE;
  gst_buffer_fill(buffer, 0, payload, run->input_size);
  GST_BUFFER_PTS(buffer) = timestamp * 100;
  GST_BUFFER_DTS(buffer) = GST_CLOCK_TIME_NONE;
  GST_BUFFER_DURATION(buffer) = read_be(run->input_header + 16, 8) * 100;
  if (!nal.idr) GST_BUFFER_FLAG_SET(buffer, GST_BUFFER_FLAG_DELTA_UNIT);
  run->encoded_started = TRUE;
  run->encoded_timestamp = timestamp;
  // appsrc blocks at one queued AU; compressed reference frames are never dropped.
  return gst_app_src_push_buffer(GST_APP_SRC(run->encoded_source), buffer) == GST_FLOW_OK;
}

static gboolean control_input(gint fd, GIOCondition condition, gpointer data) {
  CaptureRun *run = data;
  guint8 bytes[32 * 1024];
  ssize_t size = read(fd, bytes, sizeof(bytes));
  if (size < 0 && errno == EINTR) return G_SOURCE_CONTINUE;
  if (size <= 0) {
    g_atomic_int_set(&run->stopping, TRUE);
    g_main_loop_quit(run->loop);
    return G_SOURCE_CONTINUE;
  }
  (void)condition;
  gsize offset = 0;
  while (offset < (gsize)size && !g_atomic_int_get(&run->stopping)) {
    if (run->input_header_length < 32) {
      gsize take = MIN(32 - run->input_header_length, (gsize)size - offset);
      memcpy(run->input_header + run->input_header_length, bytes + offset, take);
      offset += take;
      run->input_header_length += (guint)take;
      if (run->input_header_length < 32) continue;
      if (!valid_input_header(run)) {
        fail_run(run, "invalid native input envelope");
        return G_SOURCE_CONTINUE;
      }
    }
    gsize take = MIN(run->input_size - run->input_payload->len, (gsize)size - offset);
    g_byte_array_append(run->input_payload, bytes + offset, (guint)take);
    offset += take;
    if (run->input_payload->len < run->input_size) continue;
    if (!apply_input(run)) {
      fail_run(run, "invalid or failed native input");
      return G_SOURCE_CONTINUE;
    }
    run->input_header_length = 0;
    run->input_size = 0;
    g_byte_array_set_size(run->input_payload, 0);
  }
  return G_SOURCE_CONTINUE;
}

static GstPadProbeReturn begin_input_frame(GstPad *pad, GstPadProbeInfo *info,
                                           gpointer data) {
  (void)pad;
  CaptureRun *run = data;
  GstBuffer *buffer = GST_PAD_PROBE_INFO_BUFFER(info);
  if (buffer == NULL || !GST_BUFFER_PTS_IS_VALID(buffer)) {
    fail_run(run, "capture input has no presentation timestamp");
    return GST_PAD_PROBE_DROP;
  }
  GstClockTime timestamp = GST_BUFFER_PTS(buffer);
  if (GST_CLOCK_TIME_IS_VALID(run->last_input_timestamp) &&
      timestamp <= run->last_input_timestamp) return GST_PAD_PROBE_DROP;
  run->last_input_timestamp = timestamp;
  GstClockTime duration = GST_BUFFER_DURATION_IS_VALID(buffer)
                              ? GST_BUFFER_DURATION(buffer)
                              : GST_SECOND / run->profile.frame_rate;
  if (!write_frame(5, 0, 0, 0, 0, timestamp / 100, MAX(1, duration / 100), NULL, 0)) {
    fail_run(run, "native media output closed");
    return GST_PAD_PROBE_DROP;
  }
  return GST_PAD_PROBE_OK;
}

static GstPadProbeReturn output_input_frame(GstPad *pad, GstPadProbeInfo *info,
                                            gpointer data) {
  VideoOutput *output = data;
  CaptureRun *run = output->run;
  GstBuffer *buffer = GST_PAD_PROBE_INFO_BUFFER(info);
  if (buffer == NULL || !GST_BUFFER_PTS_IS_VALID(buffer)) return GST_PAD_PROBE_DROP;
  GstClockTime timestamp = GST_BUFFER_PTS(buffer);
  g_mutex_lock(&run->lock);
  gboolean enabled = output->enabled;
  gboolean force = enabled && output->key_requested != output->key_sent;
  guint64 request = output->key_requested;
  if (enabled && !GST_CLOCK_TIME_IS_VALID(output->activation_timestamp)) {
    output->activation_timestamp = timestamp;
  }
  if (force) {
    output->key_sent = request;
    output->key_timestamp = timestamp;
  }
  g_mutex_unlock(&run->lock);
  if (!enabled) return GST_PAD_PROBE_DROP;
  if (force) {
    gboolean sent = gst_pad_push_event(pad,
        gst_video_event_new_downstream_force_key_unit(
            timestamp, GST_CLOCK_TIME_NONE, GST_CLOCK_TIME_NONE, TRUE,
            (guint)request));
    if (!sent) {
      g_mutex_lock(&run->lock);
      if (output->key_sent == request) output->key_sent = output->key_acknowledged;
      g_mutex_unlock(&run->lock);
    }
  }
  return GST_PAD_PROBE_OK;
}

static gboolean bus_message(GstBus *bus, GstMessage *message, gpointer data) {
  (void)bus;
  CaptureRun *run = data;
  if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_ERROR) {
    GError *error = NULL;
    char *debug = NULL;
    gst_message_parse_error(message, &error, &debug);
    const char *cause = error == NULL ? "GStreamer pipeline failed" : error->message;
    if (error != NULL) {
      fprintf(stderr, "Piik GStreamer error: source=%s domain=%s code=%d detail=%s\n",
              GST_MESSAGE_SRC(message) == NULL ? "unknown" : GST_OBJECT_NAME(GST_MESSAGE_SRC(message)),
              g_quark_to_string(error->domain), error->code, error->message);
      if (debug != NULL) fprintf(stderr, "Piik GStreamer context: %s\n", debug);
    }
    VideoOutput *failed = NULL;
    for (guint index = 0; index < run->output_count; ++index) {
      VideoOutput *output = &run->outputs[index];
      if (output->branch != NULL && GST_MESSAGE_SRC(message) != NULL &&
          (GST_MESSAGE_SRC(message) == GST_OBJECT(output->branch) ||
           gst_object_has_as_ancestor(GST_MESSAGE_SRC(message), GST_OBJECT(output->branch)))) {
        failed = output;
        break;
      }
    }
    if (failed == NULL) {
      fail_run(run, cause);
    } else if (!failed->failed) {
      failed->failed = TRUE;
      set_output_active(failed, FALSE);
      if (!write_frame(6, 0, (guint8)failed->layer, 0, 0, 0, 0,
                       (const guint8 *)cause, MIN(strlen(cause), 512))) {
        fail_run(run, "native media output closed");
      }
    }
    g_clear_error(&error);
    g_free(debug);
  } else if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_EOS &&
             !g_atomic_int_get(&run->stopping)) {
    fail_run(run, "GStreamer pipeline ended unexpectedly");
  }
  return G_SOURCE_CONTINUE;
}

static GstFlowReturn video_sample(GstAppSink *sink, gpointer data) {
  VideoOutput *output = data;
  CaptureRun *run = output->run;
  GstSample *sample = gst_app_sink_pull_sample(sink);
  if (sample == NULL) return GST_FLOW_EOS;
  GstBuffer *buffer = gst_sample_get_buffer(sample);
  GstMapInfo mapped = GST_MAP_INFO_INIT;
  if (buffer == NULL || !gst_buffer_map(buffer, &mapped, GST_MAP_READ) ||
      mapped.size == 0 || mapped.size > kMaxPayloadBytes) {
    if (buffer != NULL && mapped.data != NULL) gst_buffer_unmap(buffer, &mapped);
    gst_sample_unref(sample);
    fail_output(output, "GStreamer returned an invalid H.264 access unit");
    return GST_FLOW_ERROR;
  }
  gboolean key_frame = !GST_BUFFER_FLAG_IS_SET(buffer, GST_BUFFER_FLAG_DELTA_UNIT);
  NalSummary nal = inspect_h264(mapped.data, mapped.size);
  if (!GST_BUFFER_PTS_IS_VALID(buffer)) {
    gst_buffer_unmap(buffer, &mapped);
    gst_sample_unref(sample);
    fail_output(output, "encoded output lost the source presentation timestamp");
    return GST_FLOW_ERROR;
  }
  GstClockTime timestamp = GST_BUFFER_PTS(buffer);
  gboolean recovery = key_frame && nal.sps && nal.pps && nal.idr &&
                      nal.profile_level_id[0] != '\0';
  g_mutex_lock(&run->lock);
  gboolean current = output->enabled &&
      GST_CLOCK_TIME_IS_VALID(output->activation_timestamp) &&
      timestamp >= output->activation_timestamp;
  if (current && GST_CLOCK_TIME_IS_VALID(output->key_timestamp) &&
      timestamp >= output->key_timestamp) {
    if (recovery) output->key_acknowledged = output->key_sent;
    else output->key_sent = output->key_acknowledged;
  }
  if (current && recovery) output->decodable = TRUE;
  gboolean deliver = current && output->decodable;
  gboolean publish_active = deliver && !run->active &&
      output->layer == run->original_output;
  if (publish_active) run->active = TRUE;
  g_mutex_unlock(&run->lock);
  if (!deliver) {
    gst_buffer_unmap(buffer, &mapped);
    gst_sample_unref(sample);
    return GST_FLOW_OK;
  }
  gboolean written = write_frame(2, recovery ? 1 : 0, (guint8)output->layer,
                                  output->profile.width, output->profile.height,
                                  timestamp / 100,
                                  10000000ULL / output->profile.frame_rate,
                                  mapped.data, mapped.size);
  gst_buffer_unmap(buffer, &mapped);
  gst_sample_unref(sample);
  if (!written) {
    fail_run(run, "native media output closed");
    return GST_FLOW_ERROR;
  }
  if (publish_active) {
    char *token = json_string(run->restore_token);
    char *profiles = output_profiles_json(run);
    char *status = g_strdup_printf(
        "{\"state\":\"active\",\"codec\":\"h264\",\"hardwareOnly\":true,"
        "\"profileLevelId\":\"%s\",\"width\":%u,\"height\":%u,"
        "\"fps\":%u,\"restoreToken\":%s,\"outputs\":%s}",
        nal.profile_level_id, run->profile.width, run->profile.height,
        run->profile.frame_rate, token, profiles);
    g_free(token);
    g_free(profiles);
    gboolean active_written = write_status(status);
    g_free(status);
    if (!active_written) {
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
    if (!write_frame(1, 0, 0, 0, 0, run->audio_timestamp, 200000,
                     run->audio->data, kAudioFrameBytes)) {
      fail_run(run, "native audio output closed");
      return GST_FLOW_ERROR;
    }
    run->audio_timestamp += 200000;
    g_byte_array_remove_range(run->audio, 0, kAudioFrameBytes);
  }
  return GST_FLOW_OK;
}

static int run_pipeline(CaptureRun *run, const char *starting_status) {
  run->input_payload = g_byte_array_new();
  GstBus *bus = gst_element_get_bus(run->pipeline);
  guint bus_watch = gst_bus_add_watch(bus, bus_message, run);
  gst_object_unref(bus);
  guint control_watch = g_unix_fd_add(STDIN_FILENO, G_IO_IN | G_IO_HUP | G_IO_ERR,
                                     control_input, run);
  if (starting_status != NULL && !write_status(starting_status)) {
    fail_run(run, "native media output closed");
    goto stopped;
  }
  GstStateChangeReturn state =
      gst_element_set_state(run->pipeline, GST_STATE_PLAYING);
  if (state == GST_STATE_CHANGE_FAILURE) {
    fail_run(run, "GStreamer pipeline failed to start");
    goto stopped;
  }
  if (gst_element_get_state(run->pipeline, NULL, NULL, 5 * GST_SECOND) ==
      GST_STATE_CHANGE_FAILURE) {
    fail_run(run, "GStreamer pipeline failed to start");
    goto stopped;
  }
  for (guint index = 0; index < run->output_count; ++index) {
    VideoOutput *output = &run->outputs[index];
    gboolean enabled = output->enabled;
    output->enabled = FALSE;
    if (enabled) set_output_active(output, TRUE);
  }
  g_main_loop_run(run->loop);
stopped:
  g_source_remove(control_watch);
  for (guint index = 0; index < run->output_count; ++index) {
    set_output_active(&run->outputs[index], FALSE);
  }
  gst_element_set_state(run->pipeline, GST_STATE_NULL);
  g_source_remove(bus_watch);
  g_byte_array_unref(run->input_payload);
  g_mutex_lock(&run->lock);
  char *failure = g_strdup(run->failure);
  g_mutex_unlock(&run->lock);
  if (failure != NULL) {
    fprintf(stderr, "Piik capture unavailable: %s\n", failure);
    g_free(failure);
    return 2;
  }
  return 0;
}

static int capture_video(int count, char **values) {
  CaptureRun run = {.last_input_timestamp = GST_CLOCK_TIME_NONE};
  gboolean encoded = count > 1 && strcmp(values[1], "--encoded-video") == 0;
  guint encoder_index = 0;
  if (!parse_profile(count, values, &run, &encoder_index)) return 2;
  GPtrArray *encoders = hardware_encoders();
  gboolean input_available = encoded
      ? has_factory("appsrc") && has_factory("h264parse") && has_factory("decodebin")
      : video_stack_available();
  if (!input_available || encoder_index >= encoders->len) {
    g_ptr_array_unref(encoders);
    return 2;
  }
  const EncoderInfo *encoder_info = g_ptr_array_index(encoders, encoder_index);
  GError *error = NULL;
  PiikPortalCapture portal = {.pipewire_fd = -1};
  if (!encoded && !piik_portal_capture_open(
          g_getenv("PIIK_XDP_RESTORE_TOKEN"), &portal, &error)) {
    fprintf(stderr, "Piik capture unavailable: %s\n",
            error == NULL ? "screen selection failed" : error->message);
    g_clear_error(&error);
    g_ptr_array_unref(encoders);
    return 2;
  }

  GString *pipeline_text = g_string_new(NULL);
  if (encoded) {
    g_string_append(pipeline_text,
        "appsrc name=source is-live=true format=time do-timestamp=false block=true "
        "max-buffers=1 max-bytes=1048576 max-time=0 "
        "caps=video/x-h264,stream-format=byte-stream,alignment=au ! "
        "h264parse ! decodebin ! video/x-raw ! tee name=frames ");
  } else g_string_append_printf(pipeline_text,
      "pipewiresrc name=source fd=%d target-object=%s do-timestamp=true ! "
      "videorate drop-only=true ! video/x-raw,framerate=%u/1 ! tee name=frames ",
      portal.pipewire_fd, portal.target_object, run.profile.frame_rate);
  for (guint index = 0; index < run.output_count; ++index) {
    const VideoProfile *profile = &run.outputs[index].profile;
    g_string_append_printf(pipeline_text,
        "frames. ! valve name=gate%u drop=%s ! ( "
        "queue name=raw%u max-size-buffers=1 max-size-bytes=0 "
        "max-size-time=0 leaky=downstream ! videorate drop-only=true ! "
        "video/x-raw,framerate=%u/1 ! videoconvert ! videoscale ! "
        "video/x-raw,format=NV12,width=%u,height=%u ! "
        "%s name=encoder%u ! video/x-h264,profile=constrained-baseline ! "
        "h264parse config-interval=-1 ! "
        "video/x-h264,stream-format=byte-stream,alignment=au ! "
        "appsink name=output%u emit-signals=true sync=false async=false "
        "max-buffers=1 drop=false ) ",
        index, run.outputs[index].enabled ? "false" : "true",
        index, profile->frame_rate, profile->width, profile->height, encoder_info->factory,
        index, index);
  }
  GstElement *pipeline = gst_parse_launch(pipeline_text->str, &error);
  g_string_free(pipeline_text, TRUE);
  if (pipeline == NULL || error != NULL) {
    fprintf(stderr, "Piik capture unavailable: %s\n",
            error == NULL ? "video pipeline failed" : error->message);
    g_clear_error(&error);
    if (pipeline != NULL) gst_object_unref(pipeline);
    piik_portal_capture_close(&portal);
    g_ptr_array_unref(encoders);
    return 2;
  }
  run.loop = g_main_loop_new(NULL, FALSE);
  run.pipeline = pipeline;
  run.encoder_info = encoder_info;
  run.restore_token = portal.restore_token;
  g_mutex_init(&run.lock);
  int result = 2;
  GstElement *source = gst_bin_get_by_name(GST_BIN(pipeline), "source");
  if (source != NULL) {
    if (encoded) run.encoded_source = source;
    else {
      set_optional_boolean(G_OBJECT(source), "resend-last", TRUE);
      set_numeric_property(G_OBJECT(source), "keepalive-time",
                           MAX(1, 1000 / run.profile.frame_rate));
      gst_object_unref(source);
    }
  }
  GstElement *tee = gst_bin_get_by_name(GST_BIN(pipeline), "frames");
  GstPad *input = tee == NULL ? NULL : gst_element_get_static_pad(tee, "sink");
  if (tee != NULL) gst_object_unref(tee);
  if (input == NULL) goto cleanup;
  gst_pad_add_probe(input, GST_PAD_PROBE_TYPE_BUFFER, begin_input_frame, &run, NULL);
  gst_object_unref(input);
  for (guint index = 0; index < run.output_count; ++index) {
    VideoOutput *output = &run.outputs[index];
    char *name = g_strdup_printf("encoder%u", index);
    output->encoder = gst_bin_get_by_name(GST_BIN(pipeline), name);
    g_free(name);
    if (output->encoder == NULL || !configure_encoder(output)) {
      fprintf(stderr, "Piik capture unavailable: hardware encoder is incompatible\n");
      write_frame(6, 0, (guint8)index, 0, 0, 0, 0,
          (const guint8 *)"hardware encoder configuration failed",
          strlen("hardware encoder configuration failed"));
      goto cleanup;
    }
    output->branch = GST_ELEMENT(gst_object_get_parent(GST_OBJECT(output->encoder)));
    name = g_strdup_printf("gate%u", index);
    output->gate = gst_bin_get_by_name(GST_BIN(pipeline), name);
    g_free(name);
    if (output->branch == NULL || output->branch == pipeline || output->gate == NULL) goto cleanup;
    if (!isolate_output(output)) goto cleanup;
    name = g_strdup_printf("output%u", index);
    GstElement *sink = gst_bin_get_by_name(GST_BIN(pipeline), name);
    g_free(name);
    if (sink == NULL) goto cleanup;
    g_signal_connect(sink, "new-sample", G_CALLBACK(video_sample), output);
    gst_object_unref(sink);
    name = g_strdup_printf("raw%u", index);
    GstElement *queue = gst_bin_get_by_name(GST_BIN(pipeline), name);
    g_free(name);
    GstPad *raw = queue == NULL ? NULL : gst_element_get_static_pad(queue, "src");
    if (queue != NULL) gst_object_unref(queue);
    if (raw == NULL) goto cleanup;
    gst_pad_add_probe(raw, GST_PAD_PROBE_TYPE_BUFFER, output_input_frame, output, NULL);
    gst_object_unref(raw);
  }
  char *adapter_name = json_string("GStreamer hardware H.264");
  char *encoder_name = json_string(encoder_info->name);
  char *encoder_identity = json_string(encoder_info->factory);
  char *profiles = output_profiles_json(&run);
  char *starting = g_strdup_printf(
      "{\"state\":\"starting\",\"codec\":\"h264\",\"hardwareOnly\":true,"
      "\"adapterIndex\":0,\"adapterName\":%s,"
      "\"adapterIdentity\":\"gstreamer-hardware-h264\","
      "\"encoderIndex\":%u,\"encoderName\":%s,"
      "\"encoderIdentity\":%s,\"outputs\":%s}",
      adapter_name, encoder_index, encoder_name, encoder_identity, profiles);
  g_free(adapter_name);
  g_free(encoder_name);
  g_free(encoder_identity);
  g_free(profiles);
  result = run_pipeline(&run, starting);
  g_free(starting);
cleanup:
  if (run.encoded_source != NULL) gst_object_unref(run.encoded_source);
  for (guint index = 0; index < run.output_count; ++index) {
    if (run.outputs[index].encoder != NULL) gst_object_unref(run.outputs[index].encoder);
    if (run.outputs[index].branch != NULL) gst_object_unref(run.outputs[index].branch);
    if (run.outputs[index].gate != NULL) gst_object_unref(run.outputs[index].gate);
  }
  g_free(run.failure);
  g_main_loop_unref(run.loop);
  g_mutex_clear(&run.lock);
  gst_object_unref(pipeline);
  piik_portal_capture_close(&portal);
  g_ptr_array_unref(encoders);
  return result;
}

static int write_microphones(void) {
  GstDeviceMonitor *monitor = gst_device_monitor_new();
  gst_device_monitor_add_filter(monitor, "Audio/Source", NULL);
  if (!gst_device_monitor_start(monitor)) { gst_object_unref(monitor); return 2; }
  GList *devices = gst_device_monitor_get_devices(monitor);
  GString *json = g_string_new("[");
  guint count = 0;
  for (GList *item = devices; item != NULL && count < 64; item = item->next) {
    GstElement *source = gst_device_create_element(GST_DEVICE(item->data), NULL);
    GstElementFactory *factory = source == NULL ? NULL : gst_element_get_factory(source);
    if (factory != NULL && strcmp(gst_plugin_feature_get_name(GST_PLUGIN_FEATURE(factory)), "pulsesrc") == 0) {
      gchar *device = NULL;
      g_object_get(source, "device", &device, NULL);
      if (device != NULL && device[0] != '\0') {
        gchar *name = gst_device_get_display_name(GST_DEVICE(item->data));
        gchar *id_json = json_string(device), *name_json = json_string(name);
        g_string_append_printf(json, "%s{\"id\":%s,\"label\":%s}", count++ == 0 ? "" : ",", id_json, name_json);
        g_free(id_json); g_free(name_json); g_free(name);
      }
      g_free(device);
    }
    if (source != NULL) gst_object_unref(source);
  }
  g_string_append_c(json, ']');
  fputs(json->str, stdout);
  g_string_free(json, TRUE);
  g_list_free_full(devices, gst_object_unref);
  gst_device_monitor_stop(monitor);
  gst_object_unref(monitor);
  return ferror(stdout) ? 2 : 0;
}

static int capture_audio(int count, char **values) {
  gboolean microphone = (count == 2 || (count == 4 && strcmp(values[2], "--device") == 0 &&
      values[3][0] != '\0' && strlen(values[3]) <= 512)) && strcmp(values[1], "--capture-microphone") == 0;
  if (!microphone && (count != 5 || strcmp(values[1], "--capture-audio") != 0 ||
      (strcmp(values[2], "picker") != 0 &&
       strcmp(values[2], "display") != 0) ||
      strcmp(values[3], "0") != 0 ||
      strcmp(values[4], "0") != 0)) {
    return 2;
  }
  GError *error = NULL;
  if (!audio_stack_available()) return 2;
  gchar *description = g_strconcat(
      microphone ? "pulsesrc name=microphone do-timestamp=true ! " : "pulsesrc device=@DEFAULT_MONITOR@ do-timestamp=true ! ",
      "queue max-size-buffers=4 max-size-bytes=0 max-size-time=0 "
      "leaky=downstream ! audioconvert ! audioresample ! "
      "audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved ! "
      "appsink name=output emit-signals=true sync=false max-buffers=4 drop=true", NULL);
  GstElement *pipeline = gst_parse_launch(description, &error);
  g_free(description);
  if (pipeline == NULL || error != NULL) {
    g_clear_error(&error);
    if (pipeline != NULL) gst_object_unref(pipeline);
    return 2;
  }
  if (microphone && count == 4) {
    GstElement *input = gst_bin_get_by_name(GST_BIN(pipeline), "microphone");
    if (input == NULL) { gst_object_unref(pipeline); return 2; }
    g_object_set(input, "device", values[3], NULL);
    gst_object_unref(input);
  }
  CaptureRun run = {
      .loop = g_main_loop_new(NULL, FALSE),
      .pipeline = pipeline,
      .audio = g_byte_array_new(),
  };
  g_mutex_init(&run.lock);
  GstElement *output = gst_bin_get_by_name(GST_BIN(pipeline), "output");
  if (output != NULL) {
    g_signal_connect(output, "new-sample", G_CALLBACK(audio_sample), &run);
    gst_object_unref(output);
  }
  int result = output == NULL ? 2 : run_pipeline(&run, NULL);
  g_byte_array_unref(run.audio);
  g_free(run.failure);
  g_main_loop_unref(run.loop);
  g_mutex_clear(&run.lock);
  gst_object_unref(pipeline);
  return result;
}

int main(int argc, char **argv) {
  // Piik owns this CLI. Opaque device IDs must never become GStreamer flags.
  gst_init(NULL, NULL);
  if (argc == 2 && strcmp(argv[1], "--probe") == 0) return write_probe();
  if (argc == 2 && strcmp(argv[1], "--list") == 0) return write_sources();
  if (argc == 2 && strcmp(argv[1], "--list-microphones") == 0) return write_microphones();
  if (argc > 1 && (strcmp(argv[1], "--capture-video") == 0 || strcmp(argv[1], "--encoded-video") == 0)) {
    return capture_video(argc, argv);
  }
  if (argc > 1 && (strcmp(argv[1], "--capture-audio") == 0 || strcmp(argv[1], "--capture-microphone") == 0)) {
    return capture_audio(argc, argv);
  }
  fprintf(stderr, "Piik capture unavailable: unsupported command\n");
  return 2;
}
