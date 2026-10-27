import { useId, useRef, useState } from "react";
import { FloatingPanel } from "../../components/living/FloatingPanel";
import { Tooltip } from "../../components/living/Tooltip";
import { Glyph } from "../../ui/icons";
import { DesignConversation, type DesignConversationModel } from "./DesignConversation";
import { DesignCouch, type DesignReactionsModel } from "./DesignCouch";
import { DesignVoiceControls, DesignVoiceJoin, type DesignVoiceModel } from "./DesignVoiceControls";
import type { DesignCopy, DesignRoom } from "./fixtures";
import "./design-room-panel.css";

/** A second view of the current room, with the existing detachable window shell. */
export function DesignRoomPanel({ room, roomName, people, conversation, reactions, voice, copy }: {
  room: DesignRoom; roomName: string; people: number[]; conversation: DesignConversationModel;
  reactions: DesignReactionsModel; voice: DesignVoiceModel; copy: DesignCopy;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [surface, setSurface] = useState<{ open: boolean; document: Document | null }>({ open: false, document: null });
  const detached = Boolean(surface.document && surface.document !== document);
  const label = copy("房间小窗", "Room mini window");
  return <>
    <Tooltip kind="hint-window-detach" text={label}>
      <button ref={trigger} type="button" className="lr-btn is-compact is-quiet" aria-label={label}
        aria-haspopup="dialog" aria-expanded={surface.open} popoverTarget={detached ? undefined : id}
        onClick={detached ? () => surface.document?.defaultView?.focus() : undefined}>
        <Glyph name="pip" size={19} />
      </button>
    </Tooltip>
    <FloatingPanel id={id} trigger={trigger} title={roomName} icon="couch" detachable
      className="cd-room-panel" onOpenChange={(open, document) => setSurface({ open, document })}>
      {surface.open && <>
        <DesignCouch key={room.id} people={people} selfVoice={voice.joined ? { microphone: !voice.muted, deafened: voice.deafened } : false}
          copy={copy} reactions={reactions} />
        <DesignConversation room={room} roomName={roomName} copy={copy} model={conversation} showingScreens={false} compact />
        <footer className="cd-mini-voice" data-connected={voice.joined}>
          <span><Glyph name="headphones" size={16} />{voice.joined ? copy("语音已连接", "Voice connected") : copy("尚未加入语音", "Not in voice")}</span>
          <div><DesignVoiceControls voice={voice} copy={copy} /><DesignVoiceJoin voice={voice} copy={copy} /></div>
        </footer>
      </>}
    </FloatingPanel>
  </>;
}
