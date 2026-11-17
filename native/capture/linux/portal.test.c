// Exercise the RemoteDesktop persist rejection retry without a display or D-Bus session.
#include "portal.h"

#include <gio/gio.h>
#include <unistd.h>

static const char rejected[] =
    "GDBus.Error:org.freedesktop.portal.Error.InvalidArgument: "
    "Remote desktop sessions cannot persist";
static guint remote_calls;
static XdpPersistMode remote_modes[2];
static const char *remote_tokens[2];

GType xdp_portal_get_type(void) { return G_TYPE_OBJECT; }
GType xdp_session_get_type(void) { return G_TYPE_OBJECT; }

XdpPortal *xdp_portal_initable_new(GError **error) {
  (void)error;
  return (XdpPortal *)g_object_new(G_TYPE_OBJECT, NULL);
}

GDBusConnection *g_bus_get_sync(GBusType bus_type, GCancellable *cancellable,
                                GError **error) {
  (void)bus_type; (void)cancellable; (void)error;
  return (GDBusConnection *)g_object_new(G_TYPE_OBJECT, NULL);
}

GVariant *g_dbus_connection_call_sync(
    GDBusConnection *connection, const gchar *bus_name, const gchar *object_path,
    const gchar *interface_name, const gchar *method_name, GVariant *parameters,
    const GVariantType *reply_type, GDBusCallFlags flags, gint timeout_msec,
    GCancellable *cancellable, GError **error) {
  (void)connection; (void)bus_name; (void)object_path; (void)interface_name;
  (void)method_name; (void)reply_type; (void)flags; (void)timeout_msec;
  (void)cancellable; (void)error;
  if (parameters != NULL) g_variant_unref(g_variant_ref_sink(parameters));
  return g_variant_ref_sink(g_variant_new("(v)", g_variant_new_uint32(3)));
}

void g_main_loop_run(GMainLoop *loop) { (void)loop; }

void xdp_portal_create_remote_desktop_session_full(
    XdpPortal *portal, XdpDeviceType devices, XdpOutputType outputs,
    XdpRemoteDesktopFlags flags, XdpCursorMode cursor_mode,
    XdpPersistMode persist_mode, const char *restore_token,
    GCancellable *cancellable, GAsyncReadyCallback callback, gpointer data) {
  (void)devices; (void)outputs; (void)flags; (void)cursor_mode; (void)cancellable;
  g_assert_cmpuint(remote_calls, <, G_N_ELEMENTS(remote_modes));
  remote_modes[remote_calls] = persist_mode;
  remote_tokens[remote_calls] = restore_token;
  ++remote_calls;
  callback(G_OBJECT(portal), NULL, data);
}

XdpSession *xdp_portal_create_remote_desktop_session_finish(
    XdpPortal *portal, GAsyncResult *result, GError **error) {
  (void)portal; (void)result;
  if (remote_calls == 1) {
    g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_INVALID_ARGUMENT, rejected);
    return NULL;
  }
  return (XdpSession *)g_object_new(G_TYPE_OBJECT, NULL);
}

void xdp_session_start(XdpSession *session, XdpParent *parent,
                       GCancellable *cancellable, GAsyncReadyCallback callback,
                       gpointer data) {
  (void)parent; (void)cancellable;
  callback(G_OBJECT(session), NULL, data);
}

gboolean xdp_session_start_finish(XdpSession *session, GAsyncResult *result,
                                  GError **error) {
  (void)session; (void)result; (void)error;
  return TRUE;
}

XdpDeviceType xdp_session_get_devices(XdpSession *session) {
  (void)session;
  return XDP_DEVICE_KEYBOARD | XDP_DEVICE_POINTER;
}

GVariant *xdp_session_get_streams(XdpSession *session) {
  (void)session;
  GVariantBuilder streams, properties;
  g_variant_builder_init(&streams, G_VARIANT_TYPE("a(ua{sv})"));
  g_variant_builder_init(&properties, G_VARIANT_TYPE("a{sv}"));
  g_variant_builder_add(&properties, "{sv}", "logical_size",
                        g_variant_new("(ii)", 1920, 1080));
  g_variant_builder_add(&streams, "(ua{sv})", 42u, &properties);
  return g_variant_ref_sink(g_variant_builder_end(&streams));
}

int xdp_session_open_pipewire_remote(XdpSession *session) {
  (void)session;
  int fds[2];
  g_assert_cmpint(pipe(fds), ==, 0);
  close(fds[1]);
  return fds[0];
}

void xdp_session_close(XdpSession *session) { (void)session; }

XdpSessionState xdp_session_get_session_state(XdpSession *session) {
  (void)session;
  return XDP_SESSION_CLOSED;
}

char *xdp_session_get_restore_token(XdpSession *session) {
  (void)session;
  return NULL;
}

int main(void) {
  PiikPortalCapture capture = {0};
  GError *error = NULL;
  // KDE rejects the transient session; the open retries once with no token.
  g_assert_true(piik_portal_capture_open("token-1", TRUE, &capture, &error));
  g_assert_no_error(error);
  g_assert_cmpuint(remote_calls, ==, 2);
  g_assert_cmpint(remote_modes[0], ==, XDP_PERSIST_MODE_TRANSIENT);
  g_assert_cmpstr(remote_tokens[0], ==, "token-1");
  g_assert_cmpint(remote_modes[1], ==, XDP_PERSIST_MODE_NONE);
  g_assert_null(remote_tokens[1]);
  piik_portal_capture_close(&capture);
  return 0;
}
