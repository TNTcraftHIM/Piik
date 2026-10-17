#ifndef PIIK_LINUX_PORTAL_H
#define PIIK_LINUX_PORTAL_H

#include <glib.h>
#include <libportal/portal.h>

typedef struct {
  XdpPortal *portal;
  XdpSession *session;
  guint32 node_id;
  char *target_object;
  int pipewire_fd;
  char *restore_token;
  gboolean remote_input;
  gint input_width, input_height;
  gboolean keys[256], buttons[5];
} PiikPortalCapture;

gboolean piik_portal_available(void);
gboolean piik_portal_input_available(void);
gboolean piik_portal_capture_open(const char *restore_token, gboolean remote_input,
                                      PiikPortalCapture *capture,
                                      GError **error);
void piik_portal_capture_close(PiikPortalCapture *capture);
gboolean piik_portal_input(PiikPortalCapture *capture, const char *command);
void piik_portal_input_reset(PiikPortalCapture *capture);

#endif
