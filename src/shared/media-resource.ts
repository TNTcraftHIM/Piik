import {
  watch_media_fragment_bytes,
  watch_media_manifest_bytes,
} from "../../prototype/channel-browser/pkg/piik_channel_browser";
// Native and Browser share source-admission budgets; wire read windows remain separate.
export const mediaFragmentBytes = (): number => watch_media_fragment_bytes();
export const mediaManifestBytes = (): number => watch_media_manifest_bytes();
