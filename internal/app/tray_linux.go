//go:build linux

package app

import (
	"context"
	"os"
	"path/filepath"
	"time"

	"github.com/godbus/dbus/v5"
	"github.com/godbus/dbus/v5/introspect"
	"github.com/godbus/dbus/v5/prop"
)

const trayInterface = "org.kde.StatusNotifierItem"
const trayWatcher = "org.kde.StatusNotifierWatcher"
const trayPath dbus.ObjectPath = "/StatusNotifierItem"

type trayItem struct{ open func() }

// Plasma delivers its configured click/double-click action as Activate.
func (item *trayItem) Activate(_, _ int32) *dbus.Error          { item.open(); return nil }
func (item *trayItem) SecondaryActivate(_, _ int32) *dbus.Error { item.open(); return nil }
func (item *trayItem) ContextMenu(_, _ int32) *dbus.Error       { return nil }
func (item *trayItem) Scroll(_ int32, _ string) *dbus.Error     { return nil }

func startTray(ctx context.Context, open func()) (func(), error) {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil, err
	}
	fail := func(err error) (func(), error) { conn.Close(); return nil, err }
	item := &trayItem{open: open}
	if err := conn.Export(item, trayPath, trayInterface); err != nil {
		return fail(err)
	}
	exe, _ := os.Executable()
	iconPath := filepath.Join(filepath.Dir(exe), "share", "icons", "hicolor", "256x256", "apps")
	icon := "piik-app"
	if _, err := os.Stat(filepath.Join(iconPath, "piik-app.png")); err != nil {
		icon = "applications-internet"
	}
	properties := prop.Map{trayInterface: {
		"Category":      {Value: "ApplicationStatus"},
		"Id":            {Value: "piik-app"},
		"Title":         {Value: "Piik App"},
		"Status":        {Value: "Active"},
		"WindowId":      {Value: uint32(0)},
		"IconName":      {Value: icon},
		"IconThemePath": {Value: iconPath},
		"ItemIsMenu":    {Value: false},
		"Menu":          {Value: dbus.ObjectPath("/")},
	}}
	props, err := prop.Export(conn, trayPath, properties)
	if err != nil {
		return fail(err)
	}
	node := &introspect.Node{Interfaces: []introspect.Interface{
		{Name: trayInterface, Methods: introspect.Methods(item), Properties: props.Introspection(trayInterface)},
		prop.IntrospectData,
	}}
	if err := conn.Export(introspect.NewIntrospectable(node), trayPath, "org.freedesktop.DBus.Introspectable"); err != nil {
		return fail(err)
	}
	// Subscribe before registration so a restarting Plasma shell can rediscover us.
	if err := conn.AddMatchSignal(dbus.WithMatchInterface("org.freedesktop.DBus"), dbus.WithMatchMember("NameOwnerChanged"), dbus.WithMatchArg(0, trayWatcher)); err != nil {
		return fail(err)
	}
	signals := make(chan *dbus.Signal, 8)
	conn.Signal(signals)
	register := func() {
		callCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		// No watcher on non-tray desktops is normal; keep the App and Web exit usable.
		_ = conn.Object(trayWatcher, "/StatusNotifierWatcher").CallWithContext(callCtx,
			trayWatcher+".RegisterStatusNotifierItem", 0, conn.Names()[0]).Err
	}
	go func() {
		register()
		for {
			select {
			case signal, ok := <-signals:
				if !ok {
					return
				}
				if signal.Name == "org.freedesktop.DBus.NameOwnerChanged" && len(signal.Body) == 3 && signal.Body[0] == trayWatcher && signal.Body[2] != "" {
					register()
				}
			case <-conn.Context().Done():
				return
			case <-ctx.Done():
				return
			}
		}
	}()
	return func() { conn.RemoveSignal(signals); conn.Close() }, nil
}
