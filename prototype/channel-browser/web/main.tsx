import { mountApp } from "../../../src/client/mount";
import { ChannelPreviewPage } from "../../../src/client/pages/ChannelPreviewPage";
import { initTheme } from "../../../src/client/ui/theme";

initTheme();
void mountApp(<ChannelPreviewPage />);
