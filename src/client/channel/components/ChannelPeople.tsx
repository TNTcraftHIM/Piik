import { FloatingPanel } from "../../components/living/FloatingPanel";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import type { ChannelUser as User } from "../protocol";
import { voiceAppearance } from "../presentation";
import { ChannelUser } from "./ChannelUser";
import { ChannelNameEditor } from "./ChannelNameEditor";

export function ChannelPeople({ channel, roomId }: { channel: ChannelController; roomId: string }) {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const { state, self, pending, connection } = channel;
  const online = new Set(state?.sessions.filter(session => session.online).map(session => session.userId));
  const isOwner = self?.id === state?.channel.ownerId;
  const run = (operation: Promise<void>) => { void operation.catch(() => {}); };
  const row = (user: User) => {
    const sharing = state?.publications.some(publication => publication.userId === user.id && publication.kind === "screen");
    return <ChannelUser key={user.id} id={user.id} name={user.name} self={user.id === self?.id}
      owner={user.id === state?.channel.ownerId} roles={user.roles} online={online.has(user.id)}
      voice={state ? voiceAppearance(state, user.id, roomId) : undefined}
      activity={sharing ? (zh ? "正在分享画面" : "Sharing a screen") : undefined}
      rolesDisabled={connection !== "connected" || pending.has(`roles:${user.id}`)} availableRoles={state?.channel.roles}
      onRoles={isOwner ? roles => run(channel.setRoles(user.id, roles)) : undefined}>
      {user.id === self?.id && <ChannelNameEditor name={self.name} disabled={connection !== "connected" || pending.has("rename")}
        onSave={name => run(channel.renameSelf(name))} />}
    </ChannelUser>;
  };
  const users = state?.users ?? [];
  const offline = users.filter(user => !online.has(user.id));
  return <FloatingPanel id="c3-people" trigger="c3-people-trigger" title={zh ? "频道用户" : "Channel users"} icon="users" className="c3-people-panel">
    <div className="c3-people-body">
      <h3 className="c3-section-label">{zh ? `在线 ${online.size}` : `Online ${online.size}`}</h3>
      <div className="c3-users">{users.filter(user => online.has(user.id)).map(row)}</div>
      {offline.length > 0 && <details className="c3-offline-users"><summary>{zh ? `离线 ${offline.length}` : `Offline ${offline.length}`}</summary>
        <div className="c3-users">{offline.map(row)}</div>
      </details>}
    </div>
  </FloatingPanel>;
}
