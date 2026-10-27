import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { useCopy } from "../../ui/copy";

export function ChannelUser({ id, name, self, owner, roles, online, voice, activity, onRoles, rolesDisabled, availableRoles }: {
  id: string; name: string; self: boolean; owner: boolean; roles: string[]; online: boolean;
  voice?: { microphone: boolean; deafened?: boolean }; activity?: string;
  onRoles?: (roles: string[]) => void;
  rolesDisabled?: boolean; availableRoles?: { id: string; name: string }[];
}) {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const roleName = (role: string) => role === "member" ? (zh ? "成员" : "Member")
    : role === "moderator" ? (zh ? "主持人" : "Moderator") : role;
  return <div className="c3-user" data-user-id={id}>
    <div className="c3-person">
      <PawnSvg color={participantColor(id)} identity={id} host={owner} voice={voice} />
      <div>
        <strong>{name}{self ? (zh ? "（你）" : " (you)") : ""}</strong>
        <small>{[owner ? (zh ? "频道主" : "Channel owner") : "", ...roles.map(roleName)].filter(Boolean).join(" / ")}</small>
        <small>{activity || (online ? (zh ? "在线" : "Online") : (zh ? "离线" : "Offline"))}</small>
      </div>
    </div>
    {onRoles && !owner && <fieldset className="c3-role-options">
      <legend className="visually-hidden">{zh ? `${name} 的身份组` : `Roles for ${name}`}</legend>
      {(availableRoles ?? []).map(role => <label key={role.id}>
        <input type="checkbox" checked={roles.includes(role.id)} disabled={rolesDisabled}
          aria-label={`${name}: ${roleName(role.id)}`}
          onChange={event => onRoles(event.target.checked ? [...roles, role.id] : roles.filter(value => value !== role.id))} />
        {roleName(role.id) === role.id ? role.name : roleName(role.id)}
      </label>)}
    </fieldset>}
  </div>;
}
