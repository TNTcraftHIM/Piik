#ifndef SCREENER_LINUX_PORTAL_H
#define SCREENER_LINUX_PORTAL_H

#include <glib.h>
#include <libportal/portal.h>

typedef struct {
  XdpPortal *portal;
  XdpSession *session;
  guint32 node_id;
  char *target_object;
  int pipewire_fd;
  char *restore_token;
} ScreenerPortalCapture;

gboolean screener_portal_available(void);
gboolean screener_portal_capture_open(const char *restore_token,
                                      ScreenerPortalCapture *capture,
                                      GError **error);
void screener_portal_capture_close(ScreenerPortalCapture *capture);

#endif
