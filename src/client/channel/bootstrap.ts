import { takeClientLaunchBootstrap } from "../lib/app-launch";
import { applyLaunchCopy } from "../ui/copy";
import { initTheme } from "../ui/theme";
import { installBrowserDebug } from "../lib/debug";

const bootstrap = takeClientLaunchBootstrap();
initTheme(bootstrap?.theme, bootstrap?.explicit?.includes("theme") ?? false);
if (bootstrap) applyLaunchCopy(bootstrap, bootstrap.explicit?.includes("copy") ?? false);
installBrowserDebug();
