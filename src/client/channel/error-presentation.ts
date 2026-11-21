import type { CopyKey } from "../locales";
import type { UnsupportedVideoFormat } from "../native/wire";
import { isIncompatibleProtocol } from "./protocol";

export interface ChannelErrorPresentation {
  message: string | null;
  connectionHelp: boolean;
}

/** Copy and recovery guidance describe the same current failure, without owning recovery. */
export function channelErrorPresentation(error: string | null, t: (key: CopyKey, vars?: Record<string, string>) => string,
  fallback: CopyKey = "channel.error.actionFailed", unsupportedVideoFormat?: UnsupportedVideoFormat): ChannelErrorPresentation {
  const display = (key: CopyKey, connectionHelp = false): ChannelErrorPresentation => ({ message: t(key), connectionHelp });
  if (!error) return { message: null, connectionHelp: true };
  if (error === "room_busy") return display("channel.error.busy");
  if (error === "room_creation_restricted") return display("channel.error.roomCreationRestricted");
  if (error === "attachment_unavailable" || error === "file_unavailable" || error === "file_source_unavailable")
    return display("channel.attachment.sourceUnavailable");
  if (error === "file_transfer_interrupted") return display("channel.attachment.transferInterrupted");
  if (error === "saved_copy_missing") return display("channel.attachment.savedCopyMissing");
  if (error === "reveal_saved_copy_failed") return display("channel.attachment.revealSavedFailed");
  if (error === "download_failed") return display("channel.attachment.saveFailed");
  if (error === "file_offer_failed") return display("channel.attachment.fileOfferFailed");
  if (error === "preview_only")
    return display("channel.error.previewOnly");
  if (error === "webassembly_unavailable")
    return display("channel.error.webassemblyUnavailable");
  if (error === "room_runtime_unavailable")
    return display("channel.error.roomRuntimeUnavailable");
  if (isIncompatibleProtocol(error))
    return display("channel.error.incompatibleProtocol");
  if (error === "channel_full")
    return display("channel.error.channelFull");
  if (error === "directory_storage_failed")
    return display("channel.error.directoryStorageFailed");
  if (error === "room_data_removal_unconfirmed")
    return display("room.settings.roomDataRemovalUnconfirmed");
  if (error === "hosted_room_deletion_failed")
    return display("room.settings.hostedRoomDeletionFailed");
  if (error === "domain_restored_connection_failed")
    return display("channel.error.domainRestoredConnectionFailed", true);
  if (error === "room_created_connection_failed") return display("room.create.committedReconnect", true);
  if (error === "room_creation_unconfirmed") return display("room.create.unconfirmed", true);
  if (error === "room_restore_unconfirmed")
    return display("channel.error.roomRestoreUnconfirmed", true);
  if (error === "room_restored_connection_failed")
    return display("channel.error.roomRestoredConnectionFailed", true);
  if (error === "room_host_unavailable" || error === "stale_backup")
    return display("channel.error.backupStateUnavailable");
  if (error === "backup_identity_required")
    return display("channel.error.backupIdentityRequired");
  if (error === "backup_room_mismatch")
    return display("channel.error.backupRoomMismatch");
  if (error === "restore_scratch_limit")
    return display("channel.error.restoreScratchLimit");
  if (error === "backup_room_not_admitted")
    return display("channel.error.backupRoomNotAdmitted");
  if (error === "unsupported_storage_version")
    return display("channel.error.unsupportedStorageVersion");
  if (error === "unsupported_backup_version")
    return display("channel.error.unsupportedBackupVersion");
  if (error === "backup_content_limit")
    return { message: t("channel.error.backupContentLimit", { option: t("room.backup.includeFiles") }), connectionHelp: false };
  if (error === "expected_room_copy")
    return display("channel.error.expectedRoomCopy");
  if (error === "invalid_room_copy")
    return display("channel.error.invalidRoomCopy");
  if (error === "app_disconnected" || error === "app_context_changed")
    return display("channel.error.appDisconnected");
  if (error === "app_request_timeout") return display("native.fail.requestTimeout");
  if (error === "external_input_unavailable")
    return display("channel.error.externalInputUnavailable");
  if (error === "external_video_format_unsupported") {
    const recovery = t("channel.error.externalVideoFormatUnsupported");
    if (!unsupportedVideoFormat) return { message: recovery, connectionHelp: false };
    const { profileIdc, constraintFlags, levelIdc } = unsupportedVideoFormat;
    const profiles: Record<number, string> = { 66: "Baseline", 77: "Main", 88: "Extended", 100: "High", 110: "High 10", 122: "High 4:2:2", 244: "High 4:4:4" };
    const profile = profiles[profileIdc] ?? `profile_idc=${profileIdc}`;
    const level = levelIdc === 11 && [66, 77, 88].includes(profileIdc) && (constraintFlags & 0x10) !== 0 ? "1b"
      : [10, 11, 12, 13, 20, 21, 22, 30, 31, 32, 40, 41, 42, 50, 51, 52, 60, 61, 62].includes(levelIdc)
        ? `${Math.floor(levelIdc / 10)}.${levelIdc % 10}` : `level_idc=${levelIdc}`;
    const sps = [profileIdc, constraintFlags, levelIdc].map(value => value.toString(16).padStart(2, "0")).join("");
    return { message: `${t("channel.error.externalVideoFormatReceived", { profile, level, sps })} ${recovery}`, connectionHelp: false };
  }
  if (error === "external_input_failed")
    return display("channel.error.externalInputFailed");
  if (error === "watch_media_unplayable") return display("watch.sourceUnplayable");
  if (error === "watch_media_access_denied") return display("watch.mediaAccessDenied");
  if (error === "watch_media_decode_failed")
    return display("watch.decodeFailed");
  if (error === "watch_live_position_unavailable") return display("watch.livePositionUnavailable");
  if (error === "watch_source_inspection_unavailable") return display("watch.sourceAccessRequired");
  if (error === "watch_live_timeline_unsupported" || error === "watch_live_timeline_unavailable" || error === "watch_timeline_changed"
    || error === "watch_live_hls_atomic_read_required" || error === "watch_live_hls_timeline_unsupported")
    return display("watch.liveUnsupported");
  if (error === "watch_media_unsupported" || error === "watch_mp4_mse_unavailable")
    return display("watch.playbackUnsupported");
  if (error === "watch_mpd_unsupported" || error === "watch_indexed_unsupported" || error === "invalid_watch_index"
    || /^watch_(?:live_hls_unsupported|media_(?:encryption_unsupported|encoding_unsupported|range_unsupported|size_unavailable)|manifest_extension_unsupported|manifest_limit|resource_limit|mp4_parse_failed)$/.test(error))
    return display("watch.forward.unsupported");
  if (error === "watch_page_closed" || error === "page_player_closed")
    return display("watch.forward.sourceUnavailable");
  if (error === "watch_mpd_invalid") return display("watch.forward.sourceUnavailable");
  if (/^(?:watch_(?:invalid_manifest|page_unavailable|media_(?:unavailable|timeout|credentials_unavailable|changed|truncated)|resource_unavailable|source_(?:unavailable|failed|changed|retired))|invalid_watch_range_response)$/.test(error))
    return display("watch.forward.sourceUnavailable");
  if (error === "watch_source_busy" || error === "watch_read_busy")
    return display("watch.forward.busy");
  if (error === "watch_read_timeout")
    return display("watch.forward.readTimeout");
  if (error === "watch_source_already_active")
    return display("watch.forward.active");
  if (error === "watch_peer_requires_secure_context" || error === "watch_peer_unavailable")
    return display("watch.forward.secure");
  if (error === "watch_update_failed")
    return display("watch.updateFailed");
  if (error === "watch_path_unavailable")
    return display("channel.error.roomCommunicationFailed", true);
  if (error === "invalid_title")
    return display("channel.error.invalidTitle");
  if (error === "capture_failed")
    return display("channel.error.captureFailed");
  if (error === "capture_audio_failed")
    return display("channel.error.captureAudioFailed");
  if (error === "voice_noise_processing_failed") return display("voice.noise.failed");
  if (error === "voice_noise_processing_unsupported") return display("voice.noise.unsupported");
  if (error === "voice_microphone_permission_denied")
    return display("voice.error.microphoneDenied");
  if (error === "unsupported_encoding_execution")
    return display("channel.error.captureEncodingUnsupported");
  if (error === "capture_codec_unsupported")
    return display("channel.error.captureCodecUnsupported");
  if (error === "video_codec_unsupported")
    return display("channel.error.videoCodecUnsupported");
  if (error === "owner_mismatch")
    return display("channel.error.ownerMismatch");
  if (/room_host_conflict|room_storage_in_use/.test(error))
    return display("channel.error.roomHostConflict");
  if (error === "room_host_offline")
    return display("channel.error.roomHostOffline");
  if (/^(?:room_unavailable|room_not_found|invalid_room_id)$/.test(error))
    return display("channel.error.roomUnavailable");
  if (/password/i.test(error))
    return display("channel.error.passwordIncorrect");
  if (/room_access|room_forbidden/i.test(error))
    return display("channel.error.roomAccessDenied");
  if (/invit(?:e|ation)/i.test(error))
    return display("channel.error.invitationRequired");
  if (error === "invalid_owner_key")
    return display("channel.error.invalidOwnerKey");
  if (error === "invalid_credential")
    return display("channel.error.invalidCredential");
  if (/credential|unauthorized|join_required/i.test(error))
    return display("channel.error.identityUnverified");
  if (error === "session_expired")
    return display("channel.error.sessionExpired", true);
  if (error === "forbidden")
    return display("channel.error.forbidden");
  if (/permission|denied|notallowed/i.test(error))
    return display("channel.error.deviceAccessDenied");
  if (/room_(path_unavailable|delivery_unavailable|control_busy)|peer_data_unavailable|data_channel_(unavailable|busy)|request_timeout/.test(error))
    return display("channel.error.roomCommunicationFailed", true);
  if (error === "incomplete_history")
    return display("channel.error.incompleteHistory");
  if (error === "message_unavailable")
    return display("channel.error.messageUnavailable");
  if (/(capture|camera|microphone|source_audio)_unavailable|notfound|notreadable/i.test(error))
    return display("channel.error.deviceUnavailable");
  if (/disconnect|closed|offline/i.test(error))
    return display("channel.error.disconnected", true);
  return display(fallback);
}
