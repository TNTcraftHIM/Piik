import { readViewerRoute } from "./lib/session";
import { HostPage } from "./pages/HostPage";
import { ViewerPage } from "./pages/ViewerPage";

const viewerRoute = readViewerRoute();

export function App() {
  return viewerRoute ? <ViewerPage {...viewerRoute} /> : <HostPage />;
}
