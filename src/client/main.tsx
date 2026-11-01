import { lazy, Suspense, type ComponentType } from "react";
import { mountApp } from "./mount";
import { ChannelPreviewPage } from "./pages/ChannelPreviewPage";
import { AppLauncherPage } from "./pages/AppLauncherPage";
import { LoadingStatus } from "./components/living/WaitingStatus";
import "./channel/bootstrap";

const previewPages: Record<string, ComponentType> = import.meta.env.DEV ? {
  "/__tooltip-preview": lazy(() => import("./pages/TooltipPreviewPage").then(module => ({ default: module.TooltipPreviewPage }))),
  "/__status-preview": lazy(() => import("./pages/StatusPreviewPage").then(module => ({ default: module.StatusPreviewPage }))),
  "/__playback-preview": lazy(() => import("./pages/PlaybackPreviewPage").then(module => ({ default: module.PlaybackPreviewPage }))),
  "/__channel-design": lazy(() => import("./pages/ChannelDesignPage").then(module => ({ default: module.ChannelDesignPage }))),
} : {};
const PreviewPage = previewPages[location.pathname];

void mountApp(PreviewPage
  ? <Suspense fallback={<LoadingStatus label="common.loading" />}><PreviewPage /></Suspense>
  : location.pathname === "/client" || location.pathname === "/client/"
    ? <AppLauncherPage /> : <ChannelPreviewPage />);
