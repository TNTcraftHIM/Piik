import { useState, type ReactNode } from "react";
import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";

export function ChannelUser({ id, name, self, owner, roles, online, voice, activity, onRoles, rolesDisabled, availableRoles, children }: {
  id: string; name: string; self: boolean; owner: boolean; roles: string[]; online: boolean;
  voice?: { microphone: boolean; deafened?: boolean }; activity?: string; children?: ReactNode;
  onRoles?: (roles: string[]) => void;
  rolesDisabled?: boolean; availableRoles?: { id: string; name: string }[];
}) {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const [editing, setEditing] = useState(false);
  const roleName = (role: string) => role === "member" ? (zh ? "成员" : "Member")
    : role === "moderator" ? (zh ? "主持人" : "Moderator") : role;
  return <div className={`c3-user${online ? "" : " is-offline"}`} data-user-id={id}>
    <div className="c3-person c3-editable">
      <PawnSvg color={participantColor(id)} identity={id} host={owner} voice={voice} />
      <div>
        <strong>{name}{self && <span className="c3-you">{zh ? "你" : "you"}</span>}</strong>
        {(activity || owner || !online) && <small>{activity || (owner ? (zh ? "域主" : "Domain owner") : (zh ? "离线" : "Offline"))}</small>}
      </div>
      {onRoles && !owner && <button type="button" className="lr-btn is-compact is-quiet" aria-expanded={editing}
        aria-label={zh ? `${name} 的身份组` : `Roles for ${name}`} onClick={() => setEditing(!editing)}>
        <Glyph name="sliders" size={18} />
      </button>}
      {children}
    </div>
    {onRoles && !owner && editing && <fieldset className="c3-role-options">
      <legend>{zh ? "身份组" : "Roles"}</legend>
      {(availableRoles ?? []).map(role => <label key={role.id}>
        <input type="checkbox" checked={roles.includes(role.id)} disabled={rolesDisabled}
          aria-label={`${name}: ${roleName(role.id)}`}
          onChange={event => onRoles(event.target.checked ? [...roles, role.id] : roles.filter(value => value !== role.id))} />
        {roleName(role.id) === role.id ? role.name : roleName(role.id)}
      </label>)}
    </fieldset>}
  </div>;
}
