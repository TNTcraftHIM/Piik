import { useState, type ReactNode } from "react";
import { BrandMark } from "../components/living/BrandMark";
import { Btn } from "../components/living/primitives";
import { HeaderControls } from "../components/living/Header";
import { ChannelIdentityMark } from "../channel/components/ChannelIdentity";
import { ChannelRoomCreateDialog, ChannelRoomSettingsDialog } from "../channel/components/ChannelRoomControls";
import { ChannelRoomItem } from "../channel/components/ChannelRoomItem";
import type { ChannelController } from "../channel/types";
import { useCopy } from "../ui/copy";

/** Entry candidate only: creates through the existing form and resumes by room ID. */
export function ChannelSharingEntryPreview({ channel, hidden, appControl, onContinue }: {
  channel: ChannelController; hidden: boolean; appControl: ReactNode; onContinue(roomId: string): void;
}) {
  const { lang } = useCopy(), zh = lang === "zh";
  const [creating, setCreating] = useState(false), [managing, setManaging] = useState<string | null>(null);
  const rooms = channel.state?.channel.rooms ?? [];
  const managed = rooms.find(room => room.id === managing);
  return <>
    <section className="c3-entry-preview" hidden={hidden} aria-label={zh ? "极简分享入口候选" : "Simple sharing entry candidate"}>
      <header><div><BrandMark size={34} /><strong>Piik</strong><small>{zh ? "入口预览" : "Entry preview"}</small></div>
        <HeaderControls appControl={appControl} /></header>
      <main>
        <div className="c3-entry-site"><ChannelIdentityMark icon={channel.state?.channel.icon ?? "couch"} /><span>{channel.state?.channel.name}</span></div>
        <h1>{zh ? "把画面分享给朋友" : "Share your screen with friends"}</h1>
        <p>{zh ? "创建房间，开始分享，再把邀请发给朋友。" : "Create a room, start sharing, then invite your friends."}</p>
        <Btn icon="plus" tone="primary" cap={{ text: zh ? "创建新房间" : "Create a new room" }}
          title={{ text: zh ? "创建新房间" : "Create a new room" }} onClick={() => setCreating(true)} />
        {rooms.length > 0 && <section className="c3-entry-continue" aria-labelledby="c3-entry-continue-title">
          <h2 id="c3-entry-continue-title">{zh ? "继续房间" : "Continue in a room"}</h2>
          <div>{rooms.map(room => <ChannelRoomItem key={room.id} room={room} selected={false}
            settingsOpen={managed?.id === room.id} onSelect={() => onContinue(room.id)} onManage={() => setManaging(room.id)} />)}</div>
        </section>}
        <p className="c3-entry-invite-note">{zh ? "收到邀请？打开邀请链接会直达对应房间。" : "Have an invitation? Its link takes you directly to that room."}</p>
        <small className="c3-entry-preview-note">{zh ? "可操作候选：房间和画面均为本地样本，不连接服务或采集设备。" : "Interactive candidate: local rooms and pictures, without service connections or device capture."}</small>
      </main>
    </section>
    {creating && <ChannelRoomCreateDialog channel={channel} initialName={zh ? "客厅" : "Living room"}
      onCreated={onContinue} onClose={() => setCreating(false)} />}
    {managed && <ChannelRoomSettingsDialog channel={channel} room={managed} onClose={() => setManaging(null)} />}
  </>;
}
