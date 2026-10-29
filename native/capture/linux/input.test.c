// Exercise input semantics without acquiring desktop permission or injecting input.
#include "portal.h"

static XdpSessionState session_state = XDP_SESSION_ACTIVE;
static guint events, last_stream;
static int held_key, held_button, last_keysym;
static double last_x, last_y;

XdpSessionState xdp_session_get_session_state(XdpSession *session) {
  (void)session;
  return session_state;
}
void xdp_session_keyboard_key(XdpSession *session, gboolean keysym, int key, XdpKeyState state) {
  (void)session;
  ++events;
  if (keysym) last_keysym = key;
  else held_key = state == XDP_KEY_PRESSED ? key : 0;
}
void xdp_session_pointer_button(XdpSession *session, int button, XdpButtonState state) {
  (void)session;
  ++events;
  held_button = state == XDP_BUTTON_PRESSED ? button : 0;
}
void xdp_session_pointer_position(XdpSession *session, guint stream, double x, double y) {
  (void)session;
  ++events;
  last_stream = stream; last_x = x; last_y = y;
}
void xdp_session_pointer_motion(XdpSession *session, double x, double y) {
  (void)session;
  ++events;
  last_x = x; last_y = y;
}
void xdp_session_pointer_axis(XdpSession *session, gboolean finish, double x, double y) {
  (void)session; (void)finish;
  ++events;
  last_x = x; last_y = y;
}

int main(void) {
  SilipPortalCapture capture = {.session = (XdpSession *)&events, .node_id = 42,
      .input_width = 1920, .input_height = 1080};
  g_assert_false(silip_portal_input(&capture, "K 30 1"));
  g_assert_cmpuint(events, ==, 0);
  capture.remote_input = TRUE;
  g_assert_true(silip_portal_input(&capture, "M 1 1"));
  g_assert_cmpuint(last_stream, ==, 42);
  g_assert_cmpfloat(last_x, ==, 1919);
  g_assert_cmpfloat(last_y, ==, 1079);
  g_assert_true(silip_portal_input(&capture, "W -120")); // Browser scroll down.
  g_assert_cmpfloat(last_x, ==, 0);
  g_assert_cmpfloat(last_y, ==, 120);
  g_assert_true(silip_portal_input(&capture, "W 24")); // Fractional scroll up.
  g_assert_cmpfloat(last_y, ==, -24);
  g_assert_true(silip_portal_input(&capture, "K 30 1"));
  g_assert_true(silip_portal_input(&capture, "B 2 1"));
  g_assert_cmpint(held_key, ==, 30);
  g_assert_cmpint(held_button, ==, 273);
  g_assert_true(silip_portal_input(&capture, "U 20013"));
  g_assert_cmpint(last_keysym, ==, 0x01004e2d);
  g_assert_true(silip_portal_input(&capture, "Z"));
  g_assert_cmpint(held_key, ==, 0);
  g_assert_cmpint(held_button, ==, 0);
  g_assert_false(silip_portal_input(&capture, "M nan 0"));
  g_assert_false(silip_portal_input(&capture, "K 256 1"));
  session_state = XDP_SESSION_CLOSED;
  guint previous = events;
  g_assert_false(silip_portal_input(&capture, "K 30 1"));
  g_assert_cmpuint(events, ==, previous);
  return 0;
}
