import { mountApp } from "../../../src/client/mount";
import { ChannelPreviewPage } from "../../../src/client/pages/ChannelPreviewPage";
import "../../../src/client/channel/bootstrap";
import { AppLauncherPage } from "../../../src/client/pages/AppLauncherPage";

void mountApp(location.pathname === "/client" || location.pathname === "/client/" ? <AppLauncherPage /> : <ChannelPreviewPage />);
