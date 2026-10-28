import { takeClientLaunchBootstrap } from "../lib/session";
import { applyLaunchCopy } from "../ui/copy";
import { initTheme } from "../ui/theme";

const bootstrap = takeClientLaunchBootstrap();
initTheme(bootstrap.presentation?.theme, bootstrap.presentation?.explicit?.includes("theme") ?? false);
if (bootstrap.presentation) applyLaunchCopy(bootstrap.presentation, bootstrap.presentation.explicit?.includes("copy") ?? false);
