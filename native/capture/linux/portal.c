#include "portal.h"

#include <gio/gio.h>
#include <unistd.h>

typedef struct {
  GMainLoop *loop;
  XdpPortal *portal;
  XdpSession *session;
  GError *error;
} PortalRequest;

static void finish_request(PortalRequest *request, GError *error) {
  if (error != NULL) request->error = error;
  g_main_loop_quit(request->loop);
}

static void session_started(GObject *source, GAsyncResult *result,
                            gpointer data) {
  PortalRequest *request = data;
  GError *error = NULL;
  if (!xdp_session_start_finish(XDP_SESSION(source), result, &error)) {
    finish_request(request, error);
    return;
  }
  finish_request(request, NULL);
}

static void session_created(GObject *source, GAsyncResult *result,
                            gpointer data) {
  PortalRequest *request = data;
  GError *error = NULL;
  request->session = xdp_portal_create_screencast_session_finish(
      XDP_PORTAL(source), result, &error);
  if (request->session == NULL) {
    finish_request(request, error);
    return;
  }
  xdp_session_start(request->session, NULL, NULL, session_started, request);
}

gboolean screener_portal_available(void) {
  GError *error = NULL;
  GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &error);
  if (bus == NULL) {
    g_clear_error(&error);
    return FALSE;
  }
  GVariant *reply = g_dbus_connection_call_sync(
      bus, "org.freedesktop.DBus", "/org/freedesktop/DBus",
      "org.freedesktop.DBus", "NameHasOwner",
      g_variant_new("(s)", "org.freedesktop.portal.Desktop"),
      G_VARIANT_TYPE("(b)"), G_DBUS_CALL_FLAGS_NONE, 1000, NULL, &error);
  g_object_unref(bus);
  if (reply == NULL) {
    g_clear_error(&error);
    return FALSE;
  }
  gboolean available = FALSE;
  g_variant_get(reply, "(b)", &available);
  g_variant_unref(reply);
  return available;
}

gboolean screener_portal_capture_open(const char *restore_token,
                                      ScreenerPortalCapture *capture,
                                      GError **error) {
  g_return_val_if_fail(capture != NULL, FALSE);
  *capture = (ScreenerPortalCapture){.pipewire_fd = -1};

  capture->portal = xdp_portal_initable_new(error);
  if (capture->portal == NULL) return FALSE;

  PortalRequest request = {
      .loop = g_main_loop_new(NULL, FALSE),
      .portal = capture->portal,
  };
  xdp_portal_create_screencast_session(
      capture->portal, XDP_OUTPUT_MONITOR | XDP_OUTPUT_WINDOW,
      XDP_SCREENCAST_FLAG_NONE, XDP_CURSOR_MODE_EMBEDDED,
      XDP_PERSIST_MODE_PERSISTENT,
      restore_token != NULL && restore_token[0] != '\0' ? restore_token : NULL,
      NULL, session_created, &request);
  g_main_loop_run(request.loop);
  g_main_loop_unref(request.loop);
  if (request.error != NULL) {
    g_propagate_error(error, request.error);
    screener_portal_capture_close(capture);
    return FALSE;
  }
  capture->session = request.session;

  GVariant *streams = xdp_session_get_streams(capture->session);
  if (streams == NULL) {
    g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_FAILED,
                        "portal returned no screen-cast streams");
    screener_portal_capture_close(capture);
    return FALSE;
  }
  GVariantIter iterator;
  GVariant *properties = NULL;
  g_variant_iter_init(&iterator, streams);
  gboolean found = g_variant_iter_next(&iterator, "(u@a{sv})",
                                       &capture->node_id, &properties);
  if (properties != NULL) {
    guint64 serial = 0;
    if (g_variant_lookup(properties, "pipewire-serial", "t", &serial) &&
        serial > 0) {
      capture->target_object = g_strdup_printf("%" G_GUINT64_FORMAT, serial);
    }
    g_variant_unref(properties);
  }
  g_variant_unref(streams);
  if (!found || capture->node_id == 0) {
    g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_FAILED,
                        "portal returned an invalid PipeWire stream");
    screener_portal_capture_close(capture);
    return FALSE;
  }

  capture->pipewire_fd = xdp_session_open_pipewire_remote(capture->session);
  if (capture->pipewire_fd < 0) {
    g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_FAILED,
                        "portal could not open its PipeWire remote");
    screener_portal_capture_close(capture);
    return FALSE;
  }
  if (capture->target_object == NULL) {
    capture->target_object = g_strdup_printf("%u", capture->node_id);
  }
  capture->restore_token = xdp_session_get_restore_token(capture->session);
  return TRUE;
}

void screener_portal_capture_close(ScreenerPortalCapture *capture) {
  if (capture == NULL) return;
  if (capture->pipewire_fd >= 0) close(capture->pipewire_fd);
  capture->pipewire_fd = -1;
  g_clear_pointer(&capture->restore_token, g_free);
  g_clear_pointer(&capture->target_object, g_free);
  if (capture->session != NULL) {
    xdp_session_close(capture->session);
    g_clear_object(&capture->session);
  }
  g_clear_object(&capture->portal);
}
