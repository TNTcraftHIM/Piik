#include "portal.h"

#include <gio/gio.h>
#include <unistd.h>

// Ordinary capture keeps working with the existing system libportal. Remote
// input needs its restore-capable API to retain the screen across quality changes.
extern void xdp_portal_create_remote_desktop_session_full(
    XdpPortal *, XdpDeviceType, XdpOutputType, XdpRemoteDesktopFlags,
    XdpCursorMode, XdpPersistMode, const char *, GCancellable *,
    GAsyncReadyCallback, gpointer) __attribute__((weak));

typedef struct {
  GMainLoop *loop;
  XdpPortal *portal;
  XdpSession *session;
  GError *error;
  gboolean remote_input;
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
  request->session = request->remote_input
      ? xdp_portal_create_remote_desktop_session_finish(XDP_PORTAL(source), result, &error)
      : xdp_portal_create_screencast_session_finish(XDP_PORTAL(source), result, &error);
  if (request->session == NULL) {
    finish_request(request, error);
    return;
  }
  xdp_session_start(request->session, NULL, NULL, session_started, request);
}

gboolean piik_portal_available(void) {
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

gboolean piik_portal_input_available(void) {
  if (xdp_portal_create_remote_desktop_session_full == NULL) return FALSE;
  GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, NULL);
  if (bus == NULL) return FALSE;
  GVariant *reply = g_dbus_connection_call_sync(bus,
      "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
      "org.freedesktop.DBus.Properties", "Get",
      g_variant_new("(ss)", "org.freedesktop.portal.RemoteDesktop", "AvailableDeviceTypes"),
      G_VARIANT_TYPE("(v)"), G_DBUS_CALL_FLAGS_NONE, 1000, NULL, NULL);
  g_object_unref(bus);
  if (reply == NULL) return FALSE;
  GVariant *value = NULL;
  g_variant_get(reply, "(v)", &value);
  gboolean available = g_variant_is_of_type(value, G_VARIANT_TYPE_UINT32) &&
      (g_variant_get_uint32(value) & 3) == 3;
  g_variant_unref(value);
  g_variant_unref(reply);
  return available;
}

gboolean piik_portal_capture_open(const char *restore_token, gboolean remote_input,
                                      PiikPortalCapture *capture,
                                      GError **error) {
  g_return_val_if_fail(capture != NULL, FALSE);
  *capture = (PiikPortalCapture){.pipewire_fd = -1};

  capture->portal = xdp_portal_initable_new(error);
  if (capture->portal == NULL) return FALSE;

  PortalRequest request = {
      .loop = g_main_loop_new(NULL, FALSE),
      .portal = capture->portal,
      .remote_input = remote_input,
  };
  const char *token = restore_token != NULL && restore_token[0] != '\0' ? restore_token : NULL;
  if (remote_input) {
    if (!piik_portal_input_available()) {
      g_main_loop_unref(request.loop);
      g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_NOT_SUPPORTED, "desktop remote input is unavailable");
      piik_portal_capture_close(capture);
      return FALSE;
    }
    xdp_portal_create_remote_desktop_session_full(
        capture->portal, XDP_DEVICE_KEYBOARD | XDP_DEVICE_POINTER, XDP_OUTPUT_MONITOR,
        XDP_REMOTE_DESKTOP_FLAG_NONE, XDP_CURSOR_MODE_EMBEDDED,
        XDP_PERSIST_MODE_TRANSIENT, token, NULL, session_created, &request);
  } else xdp_portal_create_screencast_session(
      capture->portal, XDP_OUTPUT_MONITOR | XDP_OUTPUT_WINDOW,
      XDP_SCREENCAST_FLAG_NONE, XDP_CURSOR_MODE_EMBEDDED,
      XDP_PERSIST_MODE_PERSISTENT,
      token,
      NULL, session_created, &request);
  g_main_loop_run(request.loop);
  g_main_loop_unref(request.loop);
  capture->session = request.session;
  if (request.error != NULL) {
    g_propagate_error(error, request.error);
    piik_portal_capture_close(capture);
    return FALSE;
  }
  capture->remote_input = remote_input;
  if (remote_input && (xdp_session_get_devices(capture->session) & 3) != 3) {
    g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_PERMISSION_DENIED, "keyboard and pointer permission was not granted");
    piik_portal_capture_close(capture);
    return FALSE;
  }

  GVariant *streams = xdp_session_get_streams(capture->session);
  if (streams == NULL) {
    g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_FAILED,
                        "portal returned no screen-cast streams");
    piik_portal_capture_close(capture);
    return FALSE;
  }
  GVariantIter iterator;
  GVariant *properties = NULL;
  g_variant_iter_init(&iterator, streams);
  gboolean found = g_variant_iter_next(&iterator, "(u@a{sv})",
                                       &capture->node_id, &properties);
  if (properties != NULL) {
    if (remote_input) {
      if (!g_variant_lookup(properties, "logical_size", "(ii)", &capture->input_width, &capture->input_height))
        g_variant_lookup(properties, "size", "(ii)", &capture->input_width, &capture->input_height);
    }
    guint64 serial = 0;
    if (g_variant_lookup(properties, "pipewire-serial", "t", &serial) &&
        serial > 0) {
      capture->target_object = g_strdup_printf("%" G_GUINT64_FORMAT, serial);
    }
    g_variant_unref(properties);
  }
  g_variant_unref(streams);
  if (!found || capture->node_id == 0 || (remote_input && (capture->input_width <= 0 || capture->input_height <= 0))) {
    g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_FAILED,
                        "portal returned an invalid PipeWire stream");
    piik_portal_capture_close(capture);
    return FALSE;
  }

  capture->pipewire_fd = xdp_session_open_pipewire_remote(capture->session);
  if (capture->pipewire_fd < 0) {
    g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_FAILED,
                        "portal could not open its PipeWire remote");
    piik_portal_capture_close(capture);
    return FALSE;
  }
  capture->restore_token = xdp_session_get_restore_token(capture->session);
  return TRUE;
}

void piik_portal_capture_close(PiikPortalCapture *capture) {
  if (capture == NULL) return;
  piik_portal_input_reset(capture);
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
