import type { ReactNode } from "react";
import { useCopy } from "../../ui/copy";

// Shared by the room and its previews; actions and their state belong to the caller.
export function HostShareControls({ actions, settings, remote, pause, ending }: {
  actions?: ReactNode; settings: ReactNode; remote?: ReactNode; pause?: ReactNode; ending?: ReactNode;
}) {
  const { t } = useCopy();
  return <div className="lr-host-share-controls lr-media-controls" role="group" aria-label={t("host.shareControls")}>
    {actions && <div className="lr-host-control-group">{actions}</div>}
    <div className="lr-host-control-group">{settings}{remote}</div>
    {(pause || ending) && <div className="lr-host-control-group">{pause}{ending}</div>}
  </div>;
}
