export interface ChannelErrorPresentation {
  message: string | null;
  connectionHelp: boolean;
}

/** Copy and recovery guidance describe the same current failure, without owning recovery. */
export function channelErrorPresentation(error: string | null, copy: (zh: string, en: string) => string): ChannelErrorPresentation {
  const display = (zh: string, en: string, connectionHelp = false): ChannelErrorPresentation => ({ message: copy(zh, en), connectionHelp });
  if (!error) return { message: null, connectionHelp: true };
  if (error === "webassembly_unavailable")
    return display("当前浏览器无法运行 Piik 房间，请更新或更换浏览器。", "This browser cannot run Piik rooms. Update it or use another browser.");
  if (error === "room_runtime_unavailable")
    return display("未能加载房间组件。请刷新页面后重试。", "Could not load room components. Reload the page and try again.");
  if (error === "incompatible_protocol" || error.endsWith(": incompatible_protocol"))
    return display("版本不兼容。请刷新页面，并更新所用的 Piik App 或站点。", "Incompatible Piik versions. Refresh the page and update the App or site you are using.");
  if (error === "channel_full")
    return display("域内的同时连接数已满。请关闭不再使用的页面或 App 后重试。", "This domain has reached its connection limit. Close unused pages or Apps, then retry.");
  if (error === "user_limit")
    return display("此域已达到用户数量上限，请联系域主。", "This domain has reached its user limit. Contact the domain owner.");
  if (error === "directory_storage_failed")
    return display("房间操作已成功，但域目录保存失败。", "The room operation succeeded, but the domain directory could not be saved.");
  if (error === "app_disconnected")
    return display("与 App 的连接已断开。请确认 App 正在运行，然后重试。", "Connection to the App was lost. Check that it is running, then retry.");
  if (error === "capture_failed")
    return display("分享遇到问题，请重新选择窗口或屏幕。", "Sharing encountered a problem. Choose a window or screen again.");
  if (error === "capture_audio_failed")
    return display("无法分享声音，画面分享仍在继续。", "Could not share sound. Screen sharing continues.");
  if (error === "voice_microphone_permission_denied")
    return display("麦克风未获允许。请允许此网站使用麦克风；加入语音也可选择只收听。", "Microphone access was declined. Allow it for this site; you can also join voice as listen-only.");
  if (error === "capture_codec_unsupported")
    return display("App 不支持所选视频编码。请在分享前选择自动，或更换选源。", "The App does not support this video codec. Choose Auto before sharing, or select another source.");
  if (error === "video_codec_unsupported")
    return display("浏览器不支持所选视频编码。请在分享前选择自动或另一种编码。", "The browser does not support this video codec. Choose Auto or another codec before sharing.");
  if (error === "owner_mismatch")
    return display("App 中的房间数据属于另一个域或账号。请确认当前站点和登录账号。", "The App room data belongs to another domain or account. Check the current site and signed-in account.");
  if (/room_host_conflict|room_storage_in_use/.test(error))
    return display("这间房间已在另一处打开。请回到正在托管它的页面或 App。", "This room is already open elsewhere. Return to the page or App hosting it.");
  if (error === "room_host_offline")
    return display("房间暂不可用，请等待恢复托管。", "This room is unavailable. Wait for hosting to resume.");
  if (/domain_password/.test(error))
    return display("域口令不正确，请重新输入。", "The domain passphrase is incorrect. Please try again.");
  if (/password/i.test(error))
    return display("房间密码不正确，请重新输入。", "The room password is incorrect. Please try again.");
  if (/room_access|room_forbidden/i.test(error))
    return display("你还没有这间房间的访问权限。", "You don't have access to this room.");
  if (/invit(?:e|ation)|credential|unauthorized|join_required/i.test(error))
    return display("需要有效邀请。请向邀请方索取新的完整链接。", "A valid invitation is required. Ask the sender for a new, complete link.");
  if (error === "session_expired")
    return display("连接超时，采集已停止。重新连接后可再次分享或加入语音。", "Connection timed out. Capture stopped. Reconnect to share or join voice again.", true);
  if (error === "forbidden")
    return display("此操作需要由负责人完成。", "This action needs to be performed by its owner.");
  if (/permission|denied|notallowed/i.test(error))
    return display("设备访问未获允许，请检查浏览器或系统设置。", "Device access was declined. Check browser or system settings.");
  if (/room_(path_unavailable|delivery_unavailable|unavailable|control_busy)|peer_data_unavailable|data_channel_(unavailable|busy)|request_timeout/.test(error))
    return display("房间通信未能完成，请重试。", "Room communication did not complete. Please try again.", true);
  if (error === "incomplete_history")
    return display("聊天记录接收不完整，请重新加载。", "Chat history was interrupted. Please load it again.");
  if (/(capture|camera|microphone|source_audio)_unavailable|notfound|notreadable/i.test(error))
    return display("设备暂不可用，请检查浏览器权限及设备占用。", "Device unavailable. Check browser permissions and other apps.");
  if (/disconnect|closed|offline/i.test(error))
    return display("连接已断开，请重新连接后再试。", "Connection lost. Reconnect and try again.", true);
  return display("未能完成操作，请重试。", "Could not complete the action. Please try again.");
}
