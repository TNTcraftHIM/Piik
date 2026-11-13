import { lazy, type ComponentType } from "react";
import { mountApp } from "./mount";
import "./channel/bootstrap";
import "./ui/native-window";

const AppLauncherPage = lazy(() => import("./pages/AppLauncherPage").then(module => ({ default: module.AppLauncherPage })));
const ChannelPreviewPage = lazy(() => import("./pages/ChannelPreviewPage").then(module => ({ default: module.ChannelPreviewPage })));
const previewPages: Record<string, ComponentType> = import.meta.env.DEV ? {
  "/__tooltip-preview": lazy(() => import("./pages/TooltipPreviewPage").then(module => ({ default: module.TooltipPreviewPage }))),
  "/__status-preview": lazy(() => import("./pages/StatusPreviewPage").then(module => ({ default: module.StatusPreviewPage }))),
  "/__playback-preview": lazy(() => import("./pages/PlaybackPreviewPage").then(module => ({ default: module.PlaybackPreviewPage }))),
} : {};
const PreviewPage = previewPages[location.pathname];

void mountApp(PreviewPage
  ? <PreviewPage />
  : location.pathname === "/client" || location.pathname === "/client/"
    ? <AppLauncherPage /> : <ChannelPreviewPage />);
