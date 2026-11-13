import { useEffect, useState } from "react";
import { checkReleaseUpdate, type AppReleaseIdentity, type ReleaseIdentity, type ReleaseUpdateNotice } from "./release-update";

/** Each surface checks the connected App build, independently of the Site build. */
export function useReleaseUpdate(identity?: AppReleaseIdentity, release?: ReleaseIdentity) {
  const version = identity?.version, revision = identity?.revision, packageTarget = identity?.packageTarget;
  const releaseVersion = release?.version, releaseRevision = release?.revision;
  const key = JSON.stringify([version, revision, packageTarget, releaseVersion, releaseRevision]);
  const [result, setResult] = useState<{ key: string; notice: ReleaseUpdateNotice | null }>();
  const [check, setCheck] = useState(0);
  useEffect(() => {
    if (!version || !revision) return;
    let current = true;
    void checkReleaseUpdate({ version, revision }, { packageTarget,
      release: releaseVersion && releaseRevision ? { version: releaseVersion, revision: releaseRevision } : undefined }).then(notice => {
      if (current) setResult({ key, notice });
    }).catch(() => undefined);
    return () => { current = false; };
  }, [version, revision, packageTarget, releaseVersion, releaseRevision, key, check]);
  return { update: result?.key === key ? result.notice : null,
    refresh: () => setCheck(value => value + 1) };
}
