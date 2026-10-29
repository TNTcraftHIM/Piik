#ifndef SILIP_LINUX_PORTAL_H
#define SILIP_LINUX_PORTAL_H

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
} SilipPortalCapture;

gboolean silip_portal_available(void);
gboolean silip_portal_input_available(void);
gboolean silip_portal_capture_open(const char *restore_token, gboolean remote_input,
                                      SilipPortalCapture *capture,
                                      GError **error);
void silip_portal_capture_close(SilipPortalCapture *capture);
gboolean silip_portal_input(SilipPortalCapture *capture, const char *command);
void silip_portal_input_reset(SilipPortalCapture *capture);

#endif
