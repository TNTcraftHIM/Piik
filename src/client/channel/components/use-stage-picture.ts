import { useLayoutEffect, useRef, type RefObject } from "react";
import type { ChannelStageSource } from "./ChannelStage";
import { retainPictureInPicture } from "../../components/living/use-picture-in-picture";

type Source = Exclude<ChannelStageSource, { kind: "waiting" }>;
export interface StagePictureSource {
  roomId?: string;
  predecessor?: { kind: "screen" | "watch"; id: string };
  pictureAdmitted?: boolean;
}

export function useStagePicture(stage: RefObject<HTMLElement | null>, sources: ChannelStageSource[]) {
  const current = useRef(sources);
  const hasSources = sources.length > 0;
  const sync = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const root = stage.current;
    if (!root) return;
    let owner: { source: Pick<Source, "kind" | "id" | "roomId">; video: HTMLVideoElement; release: () => void } | undefined;
    let pending: Pick<Source, "kind" | "id"> | undefined;
    let attempt: HTMLVideoElement | undefined;
    function clear() {
      if (owner) {
        owner.release();
        owner.video.removeEventListener("leavepictureinpicture", left);
      }
      owner = undefined;
      pending = undefined;
      attempt = undefined;
    }
    function left(event: Event) {
      if (event.target === owner?.video) clear();
    }
    function entered(event: Event) {
      const video = event.target as HTMLVideoElement | null;
      if (video?.localName !== "video" || video.namespaceURI !== "http://www.w3.org/1999/xhtml") return;
      const id = video.closest<HTMLElement>("[data-publication-id]")?.dataset.publicationId;
      const source = current.current.find((s): s is Source => s.kind !== "waiting" && s.id === id && !!s.pictureAdmitted);
      if (!source) return;
      clear();
      owner = { source: { kind: source.kind, id: source.id, roomId: source.roomId }, video, release: retainPictureInPicture(video) };
      video.addEventListener("leavepictureinpicture", left);
    }
    function cancel() {
      if (owner && owner.video.ownerDocument.pictureInPictureElement === owner.video)
        void owner.video.ownerDocument.exitPictureInPicture().catch(() => {});
      clear();
    }
    function update() {
      if (!owner || owner.video.ownerDocument.pictureInPictureElement !== owner.video) return;
      const prior = pending ?? owner.source;
      const admitted = current.current.filter((s): s is Source => s.kind !== "waiting" && !!s.pictureAdmitted && s.roomId === owner?.source.roomId);
      const same = admitted.find(s => s.kind === prior.kind && s.id === prior.id);
      const successor = admitted.find(s => s.predecessor?.kind === prior.kind && s.predecessor.id === prior.id);
      if (successor) pending = { kind: successor.kind, id: successor.id };
      const next = successor ?? (pending ? same : undefined);
      if (!next && !(same?.owned || same?.subscribed)) {
        const waiting = current.current.some(s => s.kind === "waiting" && s.id === prior.id && s.roomId === owner?.source.roomId);
        if (!waiting) cancel();
        return;
      }
      if (!next || !(next.owned || next.subscribed)) return;
      const tile = root?.querySelector<HTMLElement>(`[data-publication-id="${CSS.escape(next.id)}"]`);
      const video = next.kind === "watch" ? next.player?.video : tile?.querySelector<HTMLVideoElement>('video[data-selected="true"]');
      if (!video || !tile?.contains(video) || video.readyState < 2 || attempt === video) return;
      attempt = video;
      void video.requestPictureInPicture().catch(() => { if (attempt === video) attempt = undefined; });
    }
    sync.current = update;
    root.addEventListener("enterpictureinpicture", entered, true);
    root.addEventListener("loadeddata", update, true);
    const observer = new MutationObserver(update);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-selected"] });
    return () => {
      observer.disconnect();
      root.removeEventListener("enterpictureinpicture", entered, true);
      root.removeEventListener("loadeddata", update, true);
      sync.current = () => {};
      cancel();
    };
  }, [stage, hasSources]);
  useLayoutEffect(() => { current.current = sources; sync.current(); }, [sources]);
}
