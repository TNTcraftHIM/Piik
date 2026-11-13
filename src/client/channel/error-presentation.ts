import type { CopyKey } from "../locales";

export interface ChannelErrorPresentation {
  message: string | null;
  connectionHelp: boolean;
}

/** Copy and recovery guidance describe the same current failure, without owning recovery. */
export function channelErrorPresentation(error: string | null, t: (key: CopyKey) => string): ChannelErrorPresentation {
  const display = (key: CopyKey, connectionHelp = false): ChannelErrorPresentation => ({ message: t(key), connectionHelp });
  if (!error) return { message: null, connectionHelp: true };
  if (error === "preview_only")
    return display("channel.error.previewOnly");
  if (error === "webassembly_unavailable")
    return display("channel.error.webassemblyUnavailable");
  if (error === "room_runtime_unavailable")
    return display("channel.error.roomRuntimeUnavailable");
  if (error === "incompatible_protocol" || error.endsWith(": incompatible_protocol"))
    return display("channel.error.incompatibleProtocol");
  if (error === "channel_full")
    return display("channel.error.channelFull");
  if (error === "directory_storage_failed")
    return display("channel.error.directoryStorageFailed");
  if (error === "expected_room_copy")
    return display("channel.error.expectedRoomCopy");
  if (error === "invalid_room_copy")
    return display("channel.error.invalidRoomCopy");
  if (error === "app_disconnected")
    return display("channel.error.appDisconnected");
  if (error === "external_input_unavailable")
    return display("channel.error.externalInputUnavailable");
  if (error === "external_input_failed")
    return display("channel.error.externalInputFailed");
  if (error === "invalid_title")
    return display("channel.error.invalidTitle");
  if (error === "capture_failed")
    return display("channel.error.captureFailed");
  if (error === "capture_audio_failed")
    return display("channel.error.captureAudioFailed");
  if (error === "voice_microphone_permission_denied")
    return display("voice.error.microphoneDenied");
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
  return display("channel.error.actionFailed");
}
