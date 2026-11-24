import { mountApp } from "./mount";
import { PageNotFound } from "./components/living/StartupFailure";
import "./channel/bootstrap";
import "./ui/native-window";

async function loadPage() {
  if (document.querySelector('meta[name="piik-page"][content="not-found"]')) {
    return PageNotFound;
  }
  if (import.meta.env.DEV) {
    switch (location.pathname) {
      case "/__tooltip-preview": return (await import("./pages/TooltipPreviewPage")).TooltipPreviewPage;
      case "/__status-preview": return (await import("./pages/StatusPreviewPage")).StatusPreviewPage;
      case "/__playback-preview": return (await import("./pages/PlaybackPreviewPage")).PlaybackPreviewPage;
    }
  }
  if (location.pathname === "/client" || location.pathname === "/client/") {
    return (await import("./pages/AppLauncherPage")).AppLauncherPage;
  }
  return (await import("./pages/ChannelPage")).ChannelPage;
}

void mountApp(loadPage);
