// build.sh --check uses synthetic GStreamer elements; no capture or codec is used.
#define main capture_main
#include "main.c"
#undef main

typedef struct { GstElement parent; guint bitrate; } FixtureEncoder;
typedef struct { GstElementClass parent; } FixtureEncoderClass;
G_DEFINE_TYPE(FixtureEncoder, fixture_encoder, GST_TYPE_ELEMENT)

static void fixture_set_property(GObject *object, guint id,
                                 const GValue *value, GParamSpec *property) {
  (void)id;
  (void)property;
  ((FixtureEncoder *)object)->bitrate = g_value_get_uint(value);
}

static void fixture_get_property(GObject *object, guint id,
                                 GValue *value, GParamSpec *property) {
  (void)id;
  (void)property;
  g_value_set_uint(value, ((FixtureEncoder *)object)->bitrate);
}

static void fixture_encoder_init(FixtureEncoder *encoder) {
  encoder->bitrate = 3000000;
}

static void fixture_encoder_class_init(FixtureEncoderClass *klass) {
  GObjectClass *object_class = G_OBJECT_CLASS(klass);
  object_class->set_property = fixture_set_property;
  object_class->get_property = fixture_get_property;
  g_object_class_install_property(object_class, 1,
      g_param_spec_uint("bitrate", "Bitrate", "Bitrate in bps", 1000, 12000000,
                        3000000, G_PARAM_READWRITE | GST_PARAM_MUTABLE_PLAYING));
}

static void check_encoder_admission_and_control(void) {
  GstElement *encoder = g_object_new(fixture_encoder_get_type(), NULL);
  GParamSpec *property = g_object_class_find_property(G_OBJECT_GET_CLASS(encoder), "bitrate");
  // Only this synthetic class is varied, before any pipeline owns an instance.
  const GParamFlags flags = property->flags;
  property->flags = G_PARAM_READWRITE;
  g_assert_cmpuint(bitrate_divisor(encoder), ==, 0);
  property->flags = G_PARAM_READABLE | GST_PARAM_MUTABLE_PLAYING;
  g_assert_cmpuint(bitrate_divisor(encoder), ==, 0);
  property->flags = flags;
  g_assert_cmpuint(bitrate_divisor(encoder), ==, 1);

  EncoderInfo info = {.bit_rate_divisor = bitrate_divisor(encoder)};
  CaptureRun run = {.output_count = 1, .encoder_info = &info};
  g_mutex_init(&run.lock);
  run.outputs[0] = (VideoOutput){.run = &run, .encoder = encoder,
      .profile = {.bit_rate = 3000000, .frame_rate = 30}};
  g_assert_true(configure_encoder(&run.outputs[0]));
  g_assert_true(apply_control(&run, "B 0 3000000"));
  g_assert_true(apply_control(&run, "B 0 1000000"));
  guint applied = 0;
  g_object_get(encoder, "bitrate", &applied, NULL);
  g_assert_cmpuint(applied, ==, 1000000);
  g_assert_null(run.failure);
  g_mutex_clear(&run.lock);
  gst_object_unref(encoder);
}

static void check_bus_error_retains_primary_cause(void) {
  CaptureRun run = {.loop = g_main_loop_new(NULL, FALSE), .output_count = 1};
  g_mutex_init(&run.lock);
  run.outputs[0].run = &run;
  run.outputs[0].encoder = gst_element_factory_make("identity", NULL);
  g_assert_nonnull(run.outputs[0].encoder);
  GError *error = g_error_new_literal(GST_RESOURCE_ERROR, GST_RESOURCE_ERROR_WRITE,
                                     "device returned fixture failure 42");
  GstMessage *message = gst_message_new_error(GST_OBJECT(run.outputs[0].encoder), error,
                                             "fixture encoder write");
  char *frame_path = NULL;
  int frames = g_file_open_tmp("piik-native-test-XXXXXX", &frame_path, NULL);
  g_assert_cmpint(frames, >=, 0);
  int original_stdout = dup(STDOUT_FILENO);
  g_assert_cmpint(original_stdout, >=, 0);
  g_assert_cmpint(dup2(frames, STDOUT_FILENO), >=, 0);
  g_assert_true(bus_message(NULL, message, &run));
  g_assert_cmpint(dup2(original_stdout, STDOUT_FILENO), >=, 0);
  close(original_stdout);
  close(frames);
  unlink(frame_path);
  g_free(frame_path);
  g_assert_cmpstr(run.failure, ==, error->message);
  gst_message_unref(message);
  g_error_free(error);
  gst_object_unref(run.outputs[0].encoder);
  g_free(run.failure);
  g_main_loop_unref(run.loop);
  g_mutex_clear(&run.lock);
}

static void check_slot_profiles(void) {
  char *arguments[23 + 7 * 5] = {
      "capture", "--capture-video", "picker", "1", "0", "0",
      "--adapter-index", "0", "--mft-index", "0", "--width", "1280",
      "--height", "720", "--fps", "30", "--bitrate", "3000000",
      "--preference", "balanced", "--codec", "h264", "--protocol-v7"};
  for (guint index = 0; index < 7; ++index) {
    guint offset = 23 + index * 5;
    arguments[offset] = "--output";
    arguments[offset + 1] = index == 1 ? "1280" : "854";
    arguments[offset + 2] = index == 1 ? "720" : "480";
    arguments[offset + 3] = "30";
    arguments[offset + 4] = index == 1 ? "3000000" : "2000000";
  }
  CaptureRun run = {0};
  guint encoder = 0;
  g_assert_true(parse_profile(53, arguments, &run, &encoder));
  g_assert_cmpuint(run.output_count, ==, 6);
  g_assert_cmpuint(run.original_output, ==, 1);
  for (guint index = 0; index < run.output_count; ++index) {
    g_assert_cmpint(run.outputs[index].enabled, ==, index < 2);
  }
  g_assert_false(parse_profile(58, arguments, &run, &encoder));
  arguments[23 + 5 * 5 + 1] = "1920";
  g_assert_false(parse_profile(53, arguments, &run, &encoder));
  arguments[23 + 5 * 5 + 1] = "854";
  arguments[23 + 5 + 1] = "854";
  g_assert_false(parse_profile(53, arguments, &run, &encoder));
  arguments[23 + 5 + 1] = "1280";

  char *encoded[11 + 6 * 5] = {
      "capture", "--encoded-video", "--codec", "h264", "--adapter-index", "0",
      "--mft-index", "0", "--preference", "balanced", "--protocol-v7"};
  memcpy(encoded + 11, arguments + 23, 6 * 5 * sizeof(char *));
  run = (CaptureRun){0};
  g_assert_true(parse_profile(G_N_ELEMENTS(encoded), encoded, &run, &encoder));
  g_assert_cmpuint(run.profile.width, ==, 1280);
  g_assert_cmpuint(run.profile.height, ==, 720);
  g_assert_cmpuint(run.original_output, ==, 0);
  for (guint index = 0; index < run.output_count; ++index) {
    g_assert_false(run.outputs[index].enabled);
  }
}

static GstState branch_state(VideoOutput *output) {
  GstState state = GST_STATE_VOID_PENDING;
  g_assert_cmpint(gst_element_get_state(output->branch, &state, NULL, GST_SECOND),
                 !=, GST_STATE_CHANGE_FAILURE);
  return state;
}

static void check_slot_retirement(void) {
  CaptureRun run = {.output_count = 6};
  g_mutex_init(&run.lock);
  GString *description = g_string_new("fakesrc is-live=true num-buffers=8 ! tee name=frames ");
  for (guint index = 0; index < run.output_count; ++index) {
    g_string_append_printf(description,
        "frames. ! valve name=gate%u drop=true ! ( identity name=encoder%u ! "
        "fakesink sync=false async=false ) ", index, index);
  }
  GError *error = NULL;
  run.pipeline = gst_parse_launch(description->str, &error);
  g_string_free(description, TRUE);
  g_assert_no_error(error);
  g_assert_nonnull(run.pipeline);
  for (guint index = 0; index < run.output_count; ++index) {
    VideoOutput *output = &run.outputs[index];
    output->run = &run;
    output->profile.bit_rate = 2000000;
    char *name = g_strdup_printf("encoder%u", index);
    output->encoder = gst_bin_get_by_name(GST_BIN(run.pipeline), name);
    g_free(name);
    g_assert_nonnull(output->encoder);
    output->branch = GST_ELEMENT(gst_object_get_parent(GST_OBJECT(output->encoder)));
    g_assert_true(output->branch != run.pipeline);
    name = g_strdup_printf("gate%u", index);
    output->gate = gst_bin_get_by_name(GST_BIN(run.pipeline), name);
    g_free(name);
    g_assert_nonnull(output->gate);
    gst_element_set_locked_state(output->branch, TRUE);
  }
  g_assert_cmpint(gst_element_set_state(run.pipeline, GST_STATE_PLAYING), !=, GST_STATE_CHANGE_FAILURE);
  g_assert_true(apply_control(&run, "A 1 1"));
  g_assert_true(apply_control(&run, "A 5 1"));
  g_assert_cmpint(branch_state(&run.outputs[1]), ==, GST_STATE_PLAYING);
  g_assert_cmpint(branch_state(&run.outputs[5]), ==, GST_STATE_PLAYING);
  g_assert_cmpint(branch_state(&run.outputs[2]), ==, GST_STATE_NULL);
  g_assert_true(apply_control(&run, "A 1 0"));
  g_assert_cmpint(branch_state(&run.outputs[1]), ==, GST_STATE_NULL);
  g_assert_cmpint(branch_state(&run.outputs[5]), ==, GST_STATE_PLAYING);
  g_assert_true(apply_control(&run, "A 1 1"));
  g_assert_cmpint(branch_state(&run.outputs[1]), ==, GST_STATE_PLAYING);
  g_assert_true(apply_control(&run, "K 5"));
  g_assert_false(apply_control(&run, "A 2"));
  g_assert_false(apply_control(&run, "A 6 1"));
  g_assert_false(apply_control(&run, "A 0 2"));
  g_assert_false(apply_control(&run, "B 5 999"));
  gst_element_set_state(run.pipeline, GST_STATE_NULL);
  for (guint index = 0; index < run.output_count; ++index) {
    gst_object_unref(run.outputs[index].encoder);
    gst_object_unref(run.outputs[index].branch);
    gst_object_unref(run.outputs[index].gate);
  }
  gst_object_unref(run.pipeline);
  g_mutex_clear(&run.lock);
}

int main(int argc, char **argv) {
  gst_init(&argc, &argv);
  check_encoder_admission_and_control();
  check_bus_error_retains_primary_cause();
  check_slot_profiles();
  check_slot_retirement();
  return 0;
}
