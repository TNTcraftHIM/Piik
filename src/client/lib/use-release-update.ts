import { useEffect, useState } from "react";
import { checkReleaseUpdate, type AppReleaseIdentity, type ReleaseUpdateNotice } from "./release-update";

/** Each surface checks the connected App build, independently of the Site build. */
export function useReleaseUpdate(identity?: AppReleaseIdentity) {
  const version = identity?.version, revision = identity?.revision, packageTarget = identity?.packageTarget;
  const key = JSON.stringify([version, revision, packageTarget]);
  const [result, setResult] = useState<{ key: string; notice: ReleaseUpdateNotice | null }>();
  const [check, setCheck] = useState(0);
  useEffect(() => {
    if (!version || !revision) return;
    let current = true;
    void checkReleaseUpdate({ version, revision }, { packageTarget }).then(notice => {
      if (current) setResult({ key, notice });
    }).catch(() => undefined);
    return () => { current = false; };
  }, [version, revision, packageTarget, key, check]);
  return { update: result?.key === key ? result.notice : null,
    refresh: () => setCheck(value => value + 1) };
}
