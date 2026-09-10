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
} PiikPortalCapture;

gboolean piik_portal_available(void);
gboolean piik_portal_capture_open(const char *restore_token,
                                      PiikPortalCapture *capture,
                                      GError **error);
void piik_portal_capture_close(PiikPortalCapture *capture);

#endif
