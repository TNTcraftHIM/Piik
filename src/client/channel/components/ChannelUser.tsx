import { useState, type ReactNode } from "react";
import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { Btn } from "../../components/living/primitives";
import { useCopy } from "../../ui/copy";

export function ChannelUser({ id, name, self, owner, roles, online, voice, activity, actions, onRoles, rolesDisabled, availableRoles }: {
  id: string; name: string; self: boolean; owner: boolean; roles: string[]; online: boolean;
  voice?: { microphone: boolean; deafened?: boolean }; activity?: string;
  actions?: ReactNode;
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
      <div className="c3-person-copy">
        <strong>{name}{self && <span className="c3-you">{zh ? "你" : "you"}</span>}</strong>
        {(activity || owner || !online) && <small>{activity || (owner ? (zh ? "域主" : "Domain owner") : (zh ? "离线" : "Offline"))}</small>}
      </div>
      {(actions || onRoles && !owner) && <div className="c3-person-actions">
        {actions}
        {onRoles && !owner && <Btn icon="sliders" size="dense" quiet expanded={editing}
          title={{ text: zh ? `${name} 的身份组` : `Roles for ${name}` }} onClick={() => setEditing(!editing)} />}
      </div>}
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
