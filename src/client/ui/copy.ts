// The single copy catalog. zh and en carry identical keys (type-enforced);
// "visual" is a presentation mode over the same keys, not another catalog.
//
// Store notes: lang/vis sync across tabs via the window "storage" event (a
// commit in one tab re-applies the persisted values here; theme.ts keeps its
// own per-tab store). Known trade-off: flipping lang/vis while a hint tooltip
// is open remounts the trigger, because the living primitives mount
// ComicTooltip conditionally, so keyboard focus drops to <body> on a mode
// flip. The wrapper lives outside this module; the behavior is documented
// here where the flip originates.
import { useSyncExternalStore } from "react";

export type Lang = "zh" | "en";
export type CopyMode = "text" | "vis";

const zh = {
  "brand.home": "Screener 首页",

  "common.roomCode": "房间号",
  "common.copy": "复制",
  "common.copied": "已复制",
  "common.copyFailed": "复制失败",
  "common.cancel": "取消",
  "common.retry": "重试",
  "common.refresh": "刷新页面",
  "common.edit": "编辑",
  "common.close": "收起",
  "common.viewers": "观看者",
  "common.you": "你",
  "common.host": "分享者",
  "common.name.viewerDefault": "访客",
  "common.name.hostDefault": "分享者",

  "gate.title": "站点访问",
  "gate.hint": "请输入站点口令",
  "gate.password": "站点口令",
  "gate.submit": "进入站点",
  "gate.checking": "正在验证站点访问",
  "gate.wrong": "站点口令不正确，请重试",
  "gate.unavailable": "暂时无法验证站点访问",
  "gate.malformed": "房间号格式不正确",
  "gate.malformedHint": "请输入 1000 至 9999 的四位房间号",
  "gate.unavailableRoute": "无法访问",

  "join.title": "加入房间",
  "join.hint": "输入分享者提供的房间号",
  "join.field": "房间号",
  "join.submit": "加入",
  "join.invalid": "请输入 1000 至 9999 的四位房间号",
  "join.joining": "正在加入房间",
  "join.notFound": "房间不存在或已过期",
  "join.notFoundHint": "请确认房间号，或向分享者获取新的邀请链接。",
  "join.denied": "当前无法通过房间号加入",
  "join.deniedHint": "请使用分享者提供的邀请链接，或尝试房间密码。",
  "join.password": "房间密码",
  "join.passwordError": "无法加入房间，请重试",
  "join.passwordRule": "请输入 1-{max} 个可见字符",
  "join.passwordAction": "输入房间密码",
  "join.full": "房间已满",

  "host.title": "{name} 的屏幕",
  "host.idle.heading": "想播点什么？",
  "host.idle.hint": "分享你的屏幕，朋友凭房间号或邀请链接就能进来看。",
  "host.start": "开始分享",
  "host.join": "加入房间",
  "host.starting": "正在连接",
  "host.cancelStart": "取消",
  "host.live": "正在分享",
  "host.paused": "已暂停",
  "host.ended": "已停止分享",
  "host.roomReady": "房间已就绪",
  "host.pause": "暂停分享",
  "host.resume": "恢复分享",
  "host.switchSource": "切换来源",
  "host.switching": "正在选择",
  "host.stop": "停止分享",
  "host.noAudio": "当前来源没有可共享音频",
  "host.localPreviewPaused": "本地预览已暂停，分享仍在继续",
  "host.pauseNotice": "音视频分享已暂停",
  "host.resumeNotice": "音视频分享已恢复",
  "host.stopNotice": "已停止分享",
  "host.roomReplaced": "房间号已更换",
  "host.roomInvalid": "房间已失效，再次点击将创建新房",
  "host.roomReplace": "更换房间号",
  "host.roomReplaceConfirm": "确认更换房间号",
  "host.captureError": "无法开始屏幕采集，请检查浏览器权限后重试",
  "host.terminated.stale": "页面版本已更新，请刷新后重试",
  "host.terminated.session": "此页面的会话已被另一个标签页接管",
  "host.terminated.signal": "服务器连接已终止，请刷新后重试",
  "host.notice.qualityApplied": "分享设置已应用",
  "host.notice.qualitySet": "画质已切换为 {label}",
  "host.notice.audioSet": "音频质量已切换为 {label}",
  "host.notice.partialApply": "分享设置已更新，但部分观看连接未能应用新参数",
  "host.notice.sourceSwitch.ok": "分享来源已切换",
  "host.notice.sourceSwitch.partial": "分享来源已切换，但{warning}",

  "host.name": "昵称",
  "host.nameSave": "保存昵称",
  "host.nameCancel": "取消编辑昵称",
  "host.nameEdit": "编辑昵称",
  "host.nameError": "名称格式无效或超过 24 个字符",
  "host.nameOffline": "开始分享并连接后才能修改昵称",

  "host.invite": "邀请链接",
  "host.invite.copy": "复制邀请链接",
  "host.invite.copyFailed": "无法复制邀请链接，请稍后重试",
  "host.invite.rotate": "更新邀请链接",
  "host.invite.revoke": "撤销邀请链接",
  "host.invite.rotateShort": "更新链接",
  "host.invite.revokeShort": "撤销链接",
  "host.invite.updated": "邀请链接已更新",
  "host.invite.revoked": "邀请链接已撤销",
  "host.invite.emptyOpen": "暂无邀请链接，仍可凭房间号加入",
  "host.invite.emptyPassword": "暂无邀请链接，仍可凭房间号和密码加入",
  "host.invite.emptyPrivate": "暂无邀请链接，请先更新链接再邀请他人",

  "host.policy": "准入方式",
  "host.policy.open": "公开",
  "host.policy.private": "私密",
  "host.policy.openHint": "知道房间号即可加入",
  "host.policy.privateHint": "凭邀请链接加入，或设置房间密码",
  "host.policy.setOpen": "房间已设为公开",
  "host.policy.setPrivateInvite": "房间已设为私密，仅限邀请加入",
  "host.policy.setPrivatePassword": "房间已设为私密，可凭邀请或密码加入",
  "host.password.set": "房间密码已设置",
  "host.password.unset": "房间密码未设置",
  "host.password.placeholder": "设置后可凭房间号加入",
  "host.password.setAction": "设置房间密码",
  "host.password.changeAction": "更改房间密码",
  "host.password.remove": "移除房间密码",
  "host.password.show": "显示房间密码",
  "host.password.hide": "隐藏房间密码",
  "host.password.saved": "房间密码已设置",
  "host.password.updated": "房间密码已更新",
  "host.password.removed": "房间密码已移除，仅限邀请加入",
  "host.password.rule": "房间密码只需 1-{max} 个可见字符",
  "host.accessFailed": "当前无法更新房间设置，请稍后重试",

  "host.viewers.empty": "暂无观看者",
  "host.viewers.waiting": "等待朋友加入",

  "host.quality": "视频预设",
  "host.quality.720p30": "720p · 30 帧",
  "host.quality.1080p30": "1080p · 30 帧",
  "host.quality.1080p60": "1080p · 60 帧",
  "host.advanced": "高级设置",
  "host.advanced.resolution": "分辨率上限",
  "host.advanced.framerate": "帧率上限",
  "host.advanced.bitrate": "视频码率上限",
  "host.advanced.preference": "画面偏好",
  "host.advanced.preference.resolution": "清晰",
  "host.advanced.preference.balanced": "均衡",
  "host.advanced.preference.framerate": "流畅",
  "host.advanced.preference.resolutionHint": "保留细节",
  "host.advanced.preference.balancedHint": "自动权衡",
  "host.advanced.preference.framerateHint": "优先帧率",
  "host.advanced.audio": "音频质量",
  "host.advanced.audio.saver": "普通",
  "host.advanced.audio.music": "音乐",
  "host.advanced.audio.veryHigh": "保真",
  "host.advanced.route": "路由策略",
  "host.advanced.route.topo": "自动优化拓扑",
  "host.advanced.route.topoHint": "观看中逐步选择更健康的连接",
  "host.advanced.route.peerOnly": "纯 P2P",
  "host.advanced.route.peerOnlyHint": "不使用媒体服务器，无法直连时停止尝试",
  "host.advanced.codec": "视频编码",
  "host.advanced.codec.auto": "自动",
  "host.advanced.codec.autoHint": "自动选择",
  "host.advanced.codec.vp8Hint": "兼容优先",
  "host.advanced.codec.h264Hint": "硬件优先",

  "host.details": "显示连接详情",
  "host.details.hide": "隐藏连接详情",
  "host.topology": "连接拓扑",
  "host.topology.show": "显示连接拓扑",
  "host.topology.hide": "隐藏连接拓扑",
  "host.topology.pending": "连接中",
  "host.sfu": "媒体服务器",

  "state.signal.connected": "服务器已连接",
  "state.signal.connecting": "正在连接",
  "state.signal.reconnecting": "正在恢复",
  "state.signal.offline": "服务器未连接",
  "state.peer.connected": "已连接",
  "state.peer.connecting": "正在连接",
  "state.peer.routing": "线路分配中",
  "state.peer.waiting": "等待开始分享",
  "state.peer.reconnecting": "正在恢复",
  "state.peer.failed": "连接失败",
  "state.peer.disconnected": "连接中断",
  "state.peer.closed": "已关闭",
  "state.peer.new": "准备中",
  "state.route.p2p": "P2P 直连",
  "state.route.sfu": "服务器中转",

  "stats.title": "连接数据",
  "stats.relay": "转发数据",
  "stats.downstream": "下游接收数据",
  "stats.more": "详细指标",
  "stats.less": "收起详细指标",
  "stats.resolution": "分辨率",
  "stats.fps": "帧率",
  "stats.bitrate": "码率",
  "stats.loss": "丢包率",
  "stats.rtt": "RTT",
  "stats.codec": "视频编码",
  "stats.jitter": "网络抖动",
  "stats.dropped": "丢帧",
  "stats.encoder": "编码器",
  "stats.audio": "音频码率",
  "stats.unknown": "未知",
  "stats.outgoing": "可用上行",
  "stats.qualityState": "质量状态",
  "stats.quality.normal": "正常",
  "stats.quality.bandwidth": "带宽受限",
  "stats.quality.cpu": "编码受限",
  "stats.quality.other": "其他限制",
  "stats.quality.unclassified": "未分类限制",
  "stats.capture": "捕获设置",
  "stats.inputFps": "编码输入帧率",
  "stats.encodeMs": "编码耗时/帧",
  "stats.decodeMs": "解码耗时/帧",
  "stats.freezeCount": "画面冻结",
  "stats.freezeDuration": "冻结时长",
  "stats.audioLoss": "音频丢包率",
  "stats.audioJitter": "音频抖动",
  "stats.playoutDelta": "音视频播放差",
  "stats.videoBuffer": "视频缓冲",
  "stats.audioBuffer": "音频缓冲",
  "stats.audioConcealedRate": "音频补偿率",
  "stats.audioConcealed": "音频补偿",

  "viewer.title": "{name} 的屏幕",
  "viewer.titleFallback": "好友屏幕",
  "viewer.reconnect": "重新连接媒体",
  "viewer.msg.joining": "正在加入房间",
  "viewer.msg.waitingHost": "等待开始分享",
  "viewer.msg.preparingP2p": "正在建立 P2P",
  "viewer.msg.preparingSfu": "正在连接备用线路",
  "viewer.msg.allocating": "正在分配线路",
  "viewer.msg.receiving": "正在接收画面",
  "viewer.msg.playing": "正在播放",
  "viewer.msg.needsPlay": "点击播放",
  "viewer.msg.hostPaused": "分享者已暂停",
  "viewer.msg.recovering": "正在恢复连接",
  "viewer.msg.routeFailed": "没有可用的媒体线路",
  "viewer.msg.playbackFailed": "浏览器无法播放当前画面",
  "viewer.msg.hostOffline": "分享者连接已中断",
  "viewer.msg.serverError": "连接服务暂时不可用",
  "viewer.msg.notFound": "房间不存在或已过期",
  "viewer.msg.denied": "当前无法通过房间号加入",
  "viewer.msg.invalidInvite": "邀请链接无效或已失效",
  "viewer.msg.expired": "房间已过期",
  "viewer.msg.closed": "房间已关闭",
  "viewer.msg.full": "当前无法加入房间",
  "viewer.msg.stale": "页面版本已更新，请刷新后重试",
  "viewer.msg.sessionReplaced": "此页面的会话已被另一个标签页接管",
  "viewer.msg.signalTerminated": "连接已终止，请刷新后重试",
  "viewer.notice.signalRecovering": "服务器连接正在恢复，画面仍在播放",
  "viewer.notice.mediaRecovering": "媒体连接正在恢复",
  "viewer.notice.hostOffline": "分享者连接已中断，画面可能冻结",
  "viewer.hint.denied": "请使用分享者提供的邀请链接，或尝试房间密码。",
  "viewer.hint.notFound": "请确认房间号，或向分享者获取新的邀请链接。",
  "viewer.hint.invite": "请向分享者获取新的邀请链接。",
  "viewer.hint.generic": "请检查入口后重试。",
  "viewer.error.p2p": "P2P 媒体连接异常",
  "viewer.error.relay": "下游媒体连接异常",

  "mode.language": "界面语言",
  "mode.zh": "中文",
  "mode.en": "English",
  "mode.vis": "纯视觉",
  "theme.dark": "切换到暗色模式",
  "theme.light": "切换到浅色模式",
  "theme.dark.short": "暗色",
  "theme.light.short": "浅色",

  "story.room": "找到房间",
  "story.link": "建立连接",
  "story.show": "接收画面",

  "gate.connectFailed": "无法连接站点访问服务，请重试",
  "gate.expired": "站点访问已失效，请重新验证",
  "gate.serviceUnavailable": "站点验证服务暂时不可用 ({status})",

  "host.onlineCount": "{n} / {max} 人在线",
  "host.notStarted": "尚未开始",
  "host.startCancelled": "启动已取消",
  "host.switchingSource": "正在切换来源",
  "host.capture.fpsUnknown": "帧率未知",
  "host.capture.codecPending": "编码待定",
  "host.capture.hasAudio": "含音频",
  "host.capture.noAudio": "无音频",
  "host.stageAria": "分享或加入房间",
  "host.captureAria": "实际捕获参数",
  "host.quality.title": "{label} · {mbps} Mbps",
  "host.audio.title": "{label} · {kbps} kbps 上限",
  "host.roomExpired": "房间已过期",
  "host.roomClosed": "房间已关闭",
  "host.pause.noTracksResume": "当前分享没有可恢复的媒体轨道",
  "host.pause.signalRecovering": "服务器连接正在恢复，分享仍保持暂停",
  "host.pause.noTracksPause": "当前分享没有可暂停的媒体轨道",
  "host.pause.stillPaused": "分享仍保持暂停",
  "host.shareEnded": "当前分享已经结束",
  "host.fail.start": "启动分享失败",
  "host.err.createConnection": "创建连接失败",
  "host.err.codecUnsupported": "当前浏览器无法使用支持的视频编码",
  "host.err.applySender": "应用发送参数失败",
  "host.err.applyAudioSender": "应用音频发送参数失败",
  "host.fail.source": "切换分享来源失败",
  "host.fail.quality": "应用画质设置失败",
  "host.fail.connection": "观看连接处理失败",
  "host.fail.room": "房间操作失败",
  "host.err.invalidToken": "分享凭证已失效，请重新创建房间",
  "host.err.accessDenied": "当前操作没有权限",
  "host.err.roomExpired": "房间已过期，请重新创建",
  "host.err.alreadyConnected": "此房间已在另一个页面中分享",
  "host.err.peerGone": "对应的观看连接已经离开",
  "host.err.forbidden": "当前操作不可用",
  "host.err.serverError": "服务暂时不可用，请稍后重试",
  "host.err.createRoomStatus": "当前无法创建房间 ({status})",
  "host.err.replaceRoomStatus": "当前无法更换房间 ({status})",
  "host.err.updateRoomStatus": "当前无法更新房间设置 ({status})",
  "host.capture.cancelled": "屏幕选择已取消或没有共享权限",
  "host.capture.noSource": "没有可用的屏幕分享来源",
  "host.capture.readFailed": "浏览器暂时无法读取所选分享来源",
  "host.capture.unavailable": "当前页面无法启动屏幕分享",
  "host.notice.reconnecting": "部分观看者正在重新连接",
  "host.notice.sfuRecovering": "SFU 分享来源未切换成功，正在恢复观看连接",
  "host.password.inputPlaceholder": "输入密码",

  "stats.warn.codec": "视频编码为 {codec}，预期 H264 或 VP8",
  "stats.warn.audioCodec": "音频编码为 {codec}，预期 Opus",

  "viewer.msg.joinUnavailable": "暂时无法加入房间",
  "viewer.onlineCount": "在线 {n}",
  "viewer.stageAria": "共享画面",

  "host.warn.audioUnread": "浏览器未读回音频码率上限",
  "host.warn.bandwidth": "当前连接带宽受限，画质已自动降低",
  "host.warn.encoding": "编码性能受限，画质已自动降低",
  "host.warn.other": "浏览器持续报告其他画质限制",
  "host.warn.unclassified": "浏览器持续报告未分类的画质限制",
  "host.warn.audioRewritten": "浏览器将音频码率上限改写为 {kbps} kbps",
  "host.warn.senderPartial": "浏览器未完整接受{params}",
  "host.warn.param.maxBitrate": "码率上限",
  "host.warn.param.maxFramerate": "帧率上限",
  "host.warn.param.scaleResolutionDownBy": "分辨率缩放",
  "host.warn.param.degradationPreference": "质量优先级",
  "host.warn.param.scalabilityMode": "伸缩模式",
  "host.warn.sfuRecover": "SFU {stage}失败，已启动自动恢复",
  "host.warn.sfuStage.connect": "连接",
  "host.warn.sfuStage.source": "分享源",
  "host.warn.sfuStage.videoPublish": "视频发布",
  "host.warn.sfuStage.senderConfig": "视频参数配置",
  "host.warn.sfuStage.audioPublish": "音频发布",
  "host.warn.sfuStage.transport": "传输",
  "host.fail.sfuSwitch": "切换 SFU 分享来源失败",
  "host.fail.sfuAudioParams": "应用 SFU 音频发送参数失败",
  "host.fail.sfuParams": "应用 SFU 发送参数失败",
} as const;

const en: Record<keyof typeof zh, string> = {
  "brand.home": "Screener home",

  "common.roomCode": "Room code",
  "common.copy": "Copy",
  "common.copied": "Copied",
  "common.copyFailed": "Copy failed",
  "common.cancel": "Cancel",
  "common.retry": "Retry",
  "common.refresh": "Refresh page",
  "common.edit": "Edit",
  "common.close": "Close",
  "common.viewers": "Viewers",
  "common.you": "you",
  "common.host": "Host",
  "common.name.viewerDefault": "Visitor",
  "common.name.hostDefault": "Host",

  "gate.title": "Site access",
  "gate.hint": "Enter the site passphrase",
  "gate.password": "Site passphrase",
  "gate.submit": "Enter site",
  "gate.checking": "Checking site access",
  "gate.wrong": "Incorrect passphrase, try again",
  "gate.unavailable": "Site access cannot be verified right now",
  "gate.malformed": "Invalid room code format",
  "gate.malformedHint": "Enter a four-digit room code between 1000 and 9999",
  "gate.unavailableRoute": "Unavailable",

  "join.title": "Join a room",
  "join.hint": "Enter the four-digit room code from your friend",
  "join.field": "Room code",
  "join.submit": "Join",
  "join.invalid": "Enter a four-digit room code between 1000 and 9999",
  "join.joining": "Joining the room",
  "join.notFound": "Room not found or expired",
  "join.notFoundHint": "Check the room code, or ask the host for a new invite link.",
  "join.denied": "This room cannot be joined by code right now",
  "join.deniedHint": "Use the host's invite link, or try the room password.",
  "join.password": "Room password",
  "join.passwordError": "Could not join; try again",
  "join.passwordRule": "Enter 1-{max} visible characters",
  "join.passwordAction": "Enter room password",
  "join.full": "Room is full",

  "host.title": "{name}'s screen",
  "host.idle.heading": "Something worth watching?",
  "host.idle.hint": "Share your screen and friends can drop in with the room code or invite link.",
  "host.start": "Start sharing",
  "host.join": "Join a room",
  "host.starting": "Connecting",
  "host.cancelStart": "Cancel",
  "host.live": "Live",
  "host.paused": "Paused",
  "host.ended": "Sharing stopped",
  "host.roomReady": "Room ready",
  "host.pause": "Pause sharing",
  "host.resume": "Resume sharing",
  "host.switchSource": "Switch source",
  "host.switching": "Choosing",
  "host.stop": "Stop sharing",
  "host.noAudio": "This source has no shareable audio",
  "host.localPreviewPaused": "Local preview paused; sharing continues",
  "host.pauseNotice": "Audio and video sharing paused",
  "host.resumeNotice": "Audio and video sharing resumed",
  "host.stopNotice": "Sharing stopped",
  "host.roomReplaced": "Room code replaced",
  "host.roomInvalid": "Room expired; press again to create a new one",
  "host.roomReplace": "Replace room code",
  "host.roomReplaceConfirm": "Confirm replacing the room code",
  "host.captureError": "Screen capture unavailable; check browser permission and retry",
  "host.terminated.stale": "Page updated; refresh to continue",
  "host.terminated.session": "This page's session was taken over by another tab",
  "host.terminated.signal": "Server connection terminated; refresh to continue",
  "host.notice.qualityApplied": "Share settings applied",
  "host.notice.qualitySet": "Quality switched to {label}",
  "host.notice.audioSet": "Audio quality switched to {label}",
  "host.notice.partialApply": "Settings updated, but some viewer connections could not apply them",
  "host.notice.sourceSwitch.ok": "Share source switched",
  "host.notice.sourceSwitch.partial": "Source switched, but {warning}",

  "host.name": "Display name",
  "host.nameSave": "Save display name",
  "host.nameCancel": "Cancel editing",
  "host.nameEdit": "Edit display name",
  "host.nameError": "Invalid name, or longer than 24 characters",
  "host.nameOffline": "Display name can only change while sharing and connected",

  "host.invite": "Invite link",
  "host.invite.copy": "Copy invite link",
  "host.invite.copyFailed": "Could not copy the invite link; try again",
  "host.invite.rotate": "Rotate invite link",
  "host.invite.revoke": "Revoke invite link",
  "host.invite.rotateShort": "Rotate link",
  "host.invite.revokeShort": "Revoke link",
  "host.invite.updated": "Invite link rotated",
  "host.invite.revoked": "Invite link revoked",
  "host.invite.emptyOpen": "No invite link; the room code still works",
  "host.invite.emptyPassword": "No invite link; room code plus password still works",
  "host.invite.emptyPrivate": "No invite link; rotate one before inviting",

  "host.policy": "Admission",
  "host.policy.open": "Open",
  "host.policy.private": "Private",
  "host.policy.openHint": "Anyone with the room code can join",
  "host.policy.privateHint": "Invite link only, or set a room password",
  "host.policy.setOpen": "Room is now open",
  "host.policy.setPrivateInvite": "Room is now private, invite link only",
  "host.policy.setPrivatePassword": "Room is now private, invite link or password",
  "host.password.set": "Room password set",
  "host.password.unset": "No room password",
  "host.password.placeholder": "Set one to allow code entry",
  "host.password.setAction": "Set room password",
  "host.password.changeAction": "Change room password",
  "host.password.remove": "Remove room password",
  "host.password.show": "Show room password",
  "host.password.hide": "Hide room password",
  "host.password.saved": "Room password set",
  "host.password.updated": "Room password updated",
  "host.password.removed": "Password removed; invite link only",
  "host.password.rule": "1-{max} visible characters",
  "host.accessFailed": "Cannot update room settings right now; try again later",

  "host.viewers.empty": "No viewers yet",
  "host.viewers.waiting": "Waiting for friends to join",

  "host.quality": "Video preset",
  "host.quality.720p30": "720p · 30 fps",
  "host.quality.1080p30": "1080p · 30 fps",
  "host.quality.1080p60": "1080p · 60 fps",
  "host.advanced": "Advanced settings",
  "host.advanced.resolution": "Resolution ceiling",
  "host.advanced.framerate": "Frame rate ceiling",
  "host.advanced.bitrate": "Video bitrate ceiling",
  "host.advanced.preference": "Picture preference",
  "host.advanced.preference.resolution": "Clarity",
  "host.advanced.preference.balanced": "Balanced",
  "host.advanced.preference.framerate": "Fluency",
  "host.advanced.preference.resolutionHint": "Keep detail",
  "host.advanced.preference.balancedHint": "Weigh automatically",
  "host.advanced.preference.framerateHint": "Prefer frame rate",
  "host.advanced.audio": "Audio quality",
  "host.advanced.audio.saver": "Standard",
  "host.advanced.audio.music": "Music",
  "host.advanced.audio.veryHigh": "Studio",
  "host.advanced.route": "Route policy",
  "host.advanced.route.topo": "Auto topology tuning",
  "host.advanced.route.topoHint": "Gradually pick healthier paths while live",
  "host.advanced.route.peerOnly": "Pure P2P",
  "host.advanced.route.peerOnlyHint": "No media server; stop when direct paths fail",
  "host.advanced.codec": "Video codec",
  "host.advanced.codec.auto": "Auto",
  "host.advanced.codec.autoHint": "Pick automatically",
  "host.advanced.codec.vp8Hint": "Compatibility first",
  "host.advanced.codec.h264Hint": "Hardware first",

  "host.details": "Show connection details",
  "host.details.hide": "Hide connection details",
  "host.topology": "Connection topology",
  "host.topology.show": "Show connection topology",
  "host.topology.hide": "Hide connection topology",
  "host.topology.pending": "Connecting",
  "host.sfu": "Media server",

  "state.signal.connected": "Server connected",
  "state.signal.connecting": "Connecting",
  "state.signal.reconnecting": "Recovering",
  "state.signal.offline": "Server offline",
  "state.peer.connected": "Connected",
  "state.peer.connecting": "Connecting",
  "state.peer.routing": "Routing",
  "state.peer.waiting": "Waiting for share",
  "state.peer.reconnecting": "Recovering",
  "state.peer.failed": "Connection failed",
  "state.peer.disconnected": "Connection lost",
  "state.peer.closed": "Closed",
  "state.peer.new": "Preparing",
  "state.route.p2p": "P2P direct",
  "state.route.sfu": "Via server",

  "stats.title": "Connection data",
  "stats.relay": "Relay data",
  "stats.downstream": "Downstream receive data",
  "stats.more": "Detailed metrics",
  "stats.less": "Hide detailed metrics",
  "stats.resolution": "Resolution",
  "stats.fps": "Frame rate",
  "stats.bitrate": "Bitrate",
  "stats.loss": "Packet loss",
  "stats.rtt": "RTT",
  "stats.codec": "Video codec",
  "stats.jitter": "Jitter",
  "stats.dropped": "Dropped frames",
  "stats.encoder": "Encoder",
  "stats.audio": "Audio bitrate",
  "stats.unknown": "Unknown",
  "stats.outgoing": "Available uplink",
  "stats.qualityState": "Quality state",
  "stats.quality.normal": "Normal",
  "stats.quality.bandwidth": "Bandwidth-limited",
  "stats.quality.cpu": "Encoder-limited",
  "stats.quality.other": "Other limit",
  "stats.quality.unclassified": "Unclassified limit",
  "stats.capture": "Capture settings",
  "stats.inputFps": "Encoder input rate",
  "stats.encodeMs": "Encode time/frame",
  "stats.decodeMs": "Decode time/frame",
  "stats.freezeCount": "Freezes",
  "stats.freezeDuration": "Freeze duration",
  "stats.audioLoss": "Audio packet loss",
  "stats.audioJitter": "Audio jitter",
  "stats.playoutDelta": "A/V playout delta",
  "stats.videoBuffer": "Video buffer",
  "stats.audioBuffer": "Audio buffer",
  "stats.audioConcealedRate": "Audio concealment rate",
  "stats.audioConcealed": "Audio concealments",

  "viewer.title": "{name}'s screen",
  "viewer.titleFallback": "A friend's screen",
  "viewer.reconnect": "Reconnect media",
  "viewer.msg.joining": "Joining the room",
  "viewer.msg.waitingHost": "Waiting for the host to share",
  "viewer.msg.preparingP2p": "Establishing P2P",
  "viewer.msg.preparingSfu": "Connecting backup route",
  "viewer.msg.allocating": "Allocating a route",
  "viewer.msg.receiving": "Receiving video",
  "viewer.msg.playing": "Playing",
  "viewer.msg.needsPlay": "Tap to play",
  "viewer.msg.hostPaused": "Host paused",
  "viewer.msg.recovering": "Recovering connection",
  "viewer.msg.routeFailed": "No media route available",
  "viewer.msg.playbackFailed": "The browser cannot play this stream",
  "viewer.msg.hostOffline": "Host connection lost",
  "viewer.msg.serverError": "Connection service unavailable",
  "viewer.msg.notFound": "Room not found or expired",
  "viewer.msg.denied": "This room cannot be joined by code right now",
  "viewer.msg.invalidInvite": "Invite link invalid or expired",
  "viewer.msg.expired": "Room expired",
  "viewer.msg.closed": "Room closed",
  "viewer.msg.full": "Cannot join the room right now",
  "viewer.msg.stale": "Page updated; refresh to continue",
  "viewer.msg.sessionReplaced": "This page's session was taken over by another tab",
  "viewer.msg.signalTerminated": "Connection terminated; refresh to continue",
  "viewer.notice.signalRecovering": "Server reconnecting; video keeps playing",
  "viewer.notice.mediaRecovering": "Media connection recovering",
  "viewer.notice.hostOffline": "Host connection lost; picture may freeze",
  "viewer.hint.denied": "Use the host's invite link, or try the room password.",
  "viewer.hint.notFound": "Check the room code, or ask the host for a new invite link.",
  "viewer.hint.invite": "Ask the host for a new invite link.",
  "viewer.hint.generic": "Check your entry point and try again.",
  "viewer.error.p2p": "P2P media connection error",
  "viewer.error.relay": "Downstream media connection error",

  "mode.language": "Interface language",
  "mode.zh": "中文",
  "mode.en": "English",
  "mode.vis": "Visual only",
  "theme.dark": "Switch to dark mode",
  "theme.light": "Switch to light mode",
  "theme.dark.short": "Dark",
  "theme.light.short": "Light",

  "story.room": "Room found",
  "story.link": "Linking up",
  "story.show": "Receiving picture",

  "gate.connectFailed": "Cannot reach the site access service; try again",
  "gate.expired": "Site access expired; verify again",
  "gate.serviceUnavailable": "Site access service unavailable ({status})",

  "host.onlineCount": "{n} / {max} online",
  "host.notStarted": "Not started",
  "host.startCancelled": "Start cancelled",
  "host.switchingSource": "Switching source",
  "host.capture.fpsUnknown": "Unknown frame rate",
  "host.capture.codecPending": "Codec pending",
  "host.capture.hasAudio": "With audio",
  "host.capture.noAudio": "No audio",
  "host.stageAria": "Share or join a room",
  "host.captureAria": "Actual capture parameters",
  "host.quality.title": "{label} · {mbps} Mbps",
  "host.audio.title": "{label} · {kbps} kbps ceiling",
  "host.roomExpired": "Room expired",
  "host.roomClosed": "Room closed",
  "host.pause.noTracksResume": "No resumable media tracks in the current share",
  "host.pause.signalRecovering": "Server reconnecting; sharing stays paused",
  "host.pause.noTracksPause": "No pausable media tracks in the current share",
  "host.pause.stillPaused": "Sharing stays paused",
  "host.shareEnded": "The current share has ended",
  "host.fail.start": "Failed to start sharing",
  "host.err.createConnection": "Failed to create the connection",
  "host.err.codecUnsupported": "This browser cannot use a supported video codec",
  "host.err.applySender": "Failed to apply sender parameters",
  "host.err.applyAudioSender": "Failed to apply audio sender parameters",
  "host.fail.source": "Failed to switch share source",
  "host.fail.quality": "Failed to apply quality settings",
  "host.fail.connection": "Viewer connection handling failed",
  "host.fail.room": "Room operation failed",
  "host.err.invalidToken": "Share credentials expired; create the room again",
  "host.err.accessDenied": "Not permitted",
  "host.err.roomExpired": "Room expired; create it again",
  "host.err.alreadyConnected": "This room is already shared in another page",
  "host.err.peerGone": "The viewer connection has left",
  "host.err.forbidden": "Action unavailable",
  "host.err.serverError": "Service temporarily unavailable; try again later",
  "host.err.createRoomStatus": "Cannot create a room right now ({status})",
  "host.err.replaceRoomStatus": "Cannot change rooms right now ({status})",
  "host.err.updateRoomStatus": "Cannot update room settings right now ({status})",
  "host.capture.cancelled": "Screen selection cancelled or not permitted",
  "host.capture.noSource": "No shareable screen source available",
  "host.capture.readFailed": "The browser cannot read the selected source right now",
  "host.capture.unavailable": "This page cannot start screen sharing",
  "host.notice.reconnecting": "Some viewers are reconnecting",
  "host.notice.sfuRecovering": "SFU source switch failed; restoring viewer connections",
  "host.password.inputPlaceholder": "Enter password",

  "stats.warn.codec": "Video codec is {codec}; expected H264 or VP8",
  "stats.warn.audioCodec": "Audio codec is {codec}; expected Opus",

  "viewer.msg.joinUnavailable": "Cannot join the room right now",
  "viewer.onlineCount": "{n} online",
  "viewer.stageAria": "Shared picture",

  "host.warn.audioUnread": "The browser did not report the audio bitrate ceiling",
  "host.warn.bandwidth": "This connection is bandwidth-limited; quality was reduced automatically",
  "host.warn.encoding": "Encoding performance is limited; quality was reduced automatically",
  "host.warn.other": "The browser keeps reporting other quality limits",
  "host.warn.unclassified": "The browser keeps reporting an unclassified quality limit",
  "host.warn.audioRewritten": "The browser rewrote the audio bitrate ceiling to {kbps} kbps",
  "host.warn.senderPartial": "The browser did not fully accept {params}",
  "host.warn.param.maxBitrate": "bitrate ceiling",
  "host.warn.param.maxFramerate": "frame rate ceiling",
  "host.warn.param.scaleResolutionDownBy": "resolution scaling",
  "host.warn.param.degradationPreference": "quality preference",
  "host.warn.param.scalabilityMode": "scalability mode",
  "host.warn.sfuRecover": "SFU {stage} failed; automatic recovery started",
  "host.warn.sfuStage.connect": "connect",
  "host.warn.sfuStage.source": "source",
  "host.warn.sfuStage.videoPublish": "video publish",
  "host.warn.sfuStage.senderConfig": "sender config",
  "host.warn.sfuStage.audioPublish": "audio publish",
  "host.warn.sfuStage.transport": "transport",
  "host.fail.sfuSwitch": "Failed to switch the SFU share source",
  "host.fail.sfuAudioParams": "Failed to apply SFU audio sender parameters",
  "host.fail.sfuParams": "Failed to apply SFU sender parameters",
};

export type CopyKey = keyof typeof zh;

const CATALOGS: Record<Lang, Record<CopyKey, string>> = { zh, en };

const LANG_STORAGE_KEY = "screener:ui-lang";
const MODE_STORAGE_KEY = "screener:ui-mode";

interface CopyPrefs {
  lang: Lang;
  vis: boolean;
}

function readStored(): Partial<CopyPrefs> {
  try {
    const lang = window.localStorage.getItem(LANG_STORAGE_KEY);
    const mode = window.localStorage.getItem(MODE_STORAGE_KEY);
    return {
      ...(lang === "zh" || lang === "en" ? { lang } : {}),
      ...(mode === "text" || mode === "vis" ? { vis: mode === "vis" } : {}),
    };
  } catch {
    return {};
  }
}

function detectLang(): Lang {
  return typeof navigator !== "undefined" &&
    navigator.language?.toLowerCase().startsWith("zh")
    ? "zh"
    : "en";
}

const stored = readStored();
const state: CopyPrefs = {
  lang: stored.lang ?? detectLang(),
  vis: stored.vis ?? true,
};

function syncDocumentLanguage(): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  }
}

syncDocumentLanguage();

const listeners = new Set<() => void>();

// Applies values without persisting (storage-event sync path); commit() is
// the persisting variant for local user actions.
function apply(next: Partial<CopyPrefs>): void {
  if (next.lang) state.lang = next.lang;
  if (next.vis !== undefined) state.vis = next.vis;
  syncDocumentLanguage();
  listeners.forEach((listener) => listener());
}

function commit(next: Partial<CopyPrefs>): void {
  apply(next);
  try {
    window.localStorage.setItem(LANG_STORAGE_KEY, state.lang);
    window.localStorage.setItem(MODE_STORAGE_KEY, state.vis ? "vis" : "text");
  } catch {
    // Restricted storage only disables persistence.
  }
}

// Cross-tab sync: a commit in another tab re-applies the persisted values
// here. Identical-value writes fire no storage event, so tabs converge
// without re-notify loops.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === LANG_STORAGE_KEY || event.key === MODE_STORAGE_KEY) {
      apply(readStored());
    }
  });
}

// Non-React setter (used by the mode pill and by tests).
export const setCopy = commit;

export function t(lang: Lang, key: CopyKey, vars?: Record<string, string>): string {
  let value = CATALOGS[lang][key];
  if (vars) {
    for (const [name, replacement] of Object.entries(vars)) {
      value = value.replace(`{${name}}`, replacement);
    }
  }
  return value;
}

// Non-hook accessor for transient notices composed outside React render
// (pages keep resolved strings in state; a language switch leaves an already
// shown notice in its original language until replaced).
export function say(key: CopyKey, vars?: Record<string, string>): string {
  return t(state.lang, key, vars);
}

// Locale-aware joins for composed notices (say() composites).
export function joinSentences(parts: string[]): string {
  return parts.join(state.lang === "zh" ? "；" : "; ");
}
export function joinItems(parts: string[]): string {
  return parts.join(state.lang === "zh" ? "、" : ", ");
}

export interface Copy {
  lang: Lang;
  vis: boolean;
  t: (key: CopyKey, vars?: Record<string, string>) => string;
  setLang: (lang: Lang) => void;
  setVis: (vis: boolean) => void;
}

export function useCopy(): Copy {
  const snapshot = () => `${state.lang}:${state.vis}`;
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot,
    snapshot,
  );
  const [lang, vis] = current.split(":") as [Lang, string];
  return {
    lang,
    vis: vis === "true",
    t: (key, vars) => t(lang, key, vars),
    setLang: (next) => commit({ lang: next, vis: false }),
    setVis: (next) => commit({ vis: next }),
  };
}
