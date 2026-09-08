// Build with portal.c and the same pkg-config flags as build.sh; no capture or codec is used.
#define main capture_main
#include "main.c"
#undef main

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
  check_slot_profiles();
  check_slot_retirement();
  return 0;
}
