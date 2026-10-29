#include "portal.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

static const int buttons[] = {272, 274, 273, 275, 276}; // DOM left/middle/right/back/forward

void silip_portal_input_reset(SilipPortalCapture *capture) {
  if (capture == NULL || !capture->remote_input || capture->session == NULL) return;
  gboolean active = xdp_session_get_session_state(capture->session) == XDP_SESSION_ACTIVE;
  for (guint key = 0; key < G_N_ELEMENTS(capture->keys); ++key) {
    if (active && capture->keys[key]) xdp_session_keyboard_key(capture->session, FALSE, key, XDP_KEY_RELEASED);
    capture->keys[key] = FALSE;
  }
  for (guint button = 0; button < G_N_ELEMENTS(buttons); ++button) {
    if (active && capture->buttons[button]) xdp_session_pointer_button(capture->session, buttons[button], XDP_BUTTON_RELEASED);
    capture->buttons[button] = FALSE;
  }
}

// Only the App's grant owner writes this private pipe. The Portal session owns
// the selected screen and OS permission; its teardown also releases held input.
gboolean silip_portal_input(SilipPortalCapture *capture, const char *command) {
  if (capture == NULL || !capture->remote_input || capture->session == NULL ||
      xdp_session_get_session_state(capture->session) != XDP_SESSION_ACTIVE) return FALSE;
  double x, y;
  int code, down;
  char extra;
  if (strcmp(command, "Z") == 0) {
    silip_portal_input_reset(capture);
  } else if (sscanf(command, "M %lf %lf %c", &x, &y, &extra) == 2 && isfinite(x) && isfinite(y) &&
             x >= 0 && x <= 1 && y >= 0 && y <= 1) {
    xdp_session_pointer_position(capture->session, capture->node_id,
        x * (capture->input_width - 1), y * (capture->input_height - 1));
  } else if (sscanf(command, "R %lf %lf %c", &x, &y, &extra) == 2 && isfinite(x) && isfinite(y) &&
             fabs(x) <= 32767 && fabs(y) <= 32767) {
    xdp_session_pointer_motion(capture->session, x, y);
  } else if (sscanf(command, "K %d %d %c", &code, &down, &extra) == 2 &&
             code > 0 && code < 256 && (down == 0 || down == 1)) {
    if (down || capture->keys[code]) xdp_session_keyboard_key(capture->session, FALSE, code, down);
    capture->keys[code] = down;
  } else if (sscanf(command, "B %d %d %c", &code, &down, &extra) == 2 &&
             code >= 0 && code < 5 && (down == 0 || down == 1)) {
    if (down || capture->buttons[code]) xdp_session_pointer_button(capture->session, buttons[code], down);
    capture->buttons[code] = down;
  } else if (sscanf(command, "W %d %c", &code, &extra) == 1 && code >= -1200 && code <= 1200) {
    // Silip uses positive-up wheel ticks; Portal uses positive-down axis motion.
    xdp_session_pointer_axis(capture->session, TRUE, 0, -code);
  } else if (sscanf(command, "U %d %c", &code, &extra) == 1 &&
             code >= 0 && g_unichar_validate(code) && (code >= 32 || code == '\n' || code == '\t')) {
    int keysym = code == '\n' ? 0xff0d : code == '\t' ? 0xff09 : code <= 255 ? code : 0x01000000 | code;
    xdp_session_keyboard_key(capture->session, TRUE, keysym, XDP_KEY_PRESSED);
    xdp_session_keyboard_key(capture->session, TRUE, keysym, XDP_KEY_RELEASED);
  } else return FALSE;
  return TRUE;
}
