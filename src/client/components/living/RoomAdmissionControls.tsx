import type { Dispatch, SetStateAction } from "react";
import { MAX_VIEWER_PASSWORD_LENGTH, type CodeEntryPolicy } from "../../../shared/protocol";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Tooltip } from "./Tooltip";
import { Btn, Cap, Pill, Row, RowGroup, SwitchItem } from "./primitives";

interface Props {
  roomLink: string | null | undefined;
  inviteAvailable: boolean;
  revokeAvailable?: boolean;
  roomLinkBlocked: boolean;
  copied: boolean;
  includeInviteCredential: boolean;
  roomMutating: boolean;
  activeCodeEntryPolicy: CodeEntryPolicy | null;
  viewerPasswordEnabled: boolean;
  passwordOpen: boolean;
  viewerPasswordDraft: string;
  viewerPasswordVisible: boolean;
  savedPassword: string | null;
  copyRoomLink: () => Promise<void>;
  changeViewerGrant: (action: "rotate" | "revoke") => Promise<void>;
  changeCodeEntryPolicy: (policy: CodeEntryPolicy) => Promise<void>;
  changeViewerPassword: (password: string | null) => Promise<void>;
  setIncludeInviteCredential: (value: boolean) => void;
  setPasswordOpen: Dispatch<SetStateAction<boolean>>;
  setViewerPasswordDraft: (value: string) => void;
  setViewerPasswordVisible: Dispatch<SetStateAction<boolean>>;
}

export function RoomAdmissionControls({
  roomLink, inviteAvailable, revokeAvailable = inviteAvailable, roomLinkBlocked, copied, includeInviteCredential,
  roomMutating, activeCodeEntryPolicy, viewerPasswordEnabled, passwordOpen,
  viewerPasswordDraft, viewerPasswordVisible, savedPassword,
  copyRoomLink, changeViewerGrant, changeCodeEntryPolicy, changeViewerPassword,
  setIncludeInviteCredential, setPasswordOpen, setViewerPasswordDraft, setViewerPasswordVisible,
}: Props) {
  const { t, vis } = useCopy();
  return (
    <Row label={t("host.policy")}>
      <RowGroup actions>
        <Btn
          icon={copied ? "check" : "link"}
          cap="common.copy"
          title={copied ? "common.copied" : roomLinkBlocked ? "host.invite.credentialRequired"
            : includeInviteCredential ? "host.invite.copy" : "host.invite.copyAddress"}
          hint={roomLinkBlocked ? "hint-policy-private" : "hint-copy-invite"}
          hintTone={copied ? "live" : roomLinkBlocked ? "warn" : undefined}
          hintMotion={copied ? "still" : undefined}
          disabled={!roomLink || roomMutating || roomLinkBlocked}
          onClick={() => void copyRoomLink()}
        />
        <Btn
          icon="refresh"
          cap="host.invite.rotateShort"
          title="host.invite.rotate"
          hint="hint-rotate-invite"
          disabled={roomMutating}
          onClick={() => void changeViewerGrant("rotate")}
        />
        <Btn
          icon="linkOff"
          tone="danger"
          cap="host.invite.revokeShort"
          title="host.invite.revoke"
          hint="hint-revoke-invite"
          disabled={!revokeAvailable || roomMutating}
          onClick={() => void changeViewerGrant("revoke")}
        />
      </RowGroup>
      <div className="lr-invite-field">
        {roomLink ? (
          <Tooltip kind="hint-invite-link" text={roomLink} className="lr-invite-hint">
            <input
              className="lr-invite-url"
              type="text"
              dir="ltr"
              value={roomLink}
              readOnly
              spellCheck={false}
              aria-label={t(includeInviteCredential ? "host.invite" : "host.invite.address")}
              onFocus={(event) => event.currentTarget.select()}
            />
          </Tooltip>
        ) : null}
        <span className="lr-row-group">
          <Glyph name="key" size={17} />
          <SwitchItem checked={includeInviteCredential} disabled={roomMutating}
            label={t("host.invite.includeCredential")} hint="hint-invite-link"
            note={t("host.invite.credentialHint")}
            onChange={checked => {
              setIncludeInviteCredential(checked);
            }} />
        </span>
      </div>
      {roomLinkBlocked ? <Pill icon="lock" tone="warn" comic="hint-policy-private"
        label={t("host.invite.credentialRequired")} /> : null}
      <span className="lr-divider" aria-hidden="true" />
      <RowGroup>
        <span
          className="lr-toggle"
          role="group"
          aria-label={t("host.policy")}
        >
          <Tooltip kind="hint-admission-code"
            text={vis ? undefined : `${t("host.policy.open")}\n${t("host.policy.openHint")}`}>
            <button
              type="button"
              className={
                activeCodeEntryPolicy === "open" ? "is-selected" : undefined
              }
              aria-label={t("host.policy.open")}
              aria-pressed={activeCodeEntryPolicy === "open"}
              disabled={roomMutating}
              onClick={() => void changeCodeEntryPolicy("open")}
            >
              <Glyph name="globe" size={19} />
              <Cap k="host.policy.open" />
            </button>
          </Tooltip>
          <Tooltip kind="hint-policy-private"
            text={vis ? undefined : `${t("host.policy.private")}\n${t(viewerPasswordEnabled ? "host.policy.privatePasswordHint" : "host.policy.privateHint")}`}>
            <button
              type="button"
              className={
                activeCodeEntryPolicy === "private"
                  ? "is-selected"
                  : undefined
              }
              aria-label={t("host.policy.private")}
              aria-pressed={activeCodeEntryPolicy === "private"}
              disabled={roomMutating}
              onClick={() => void changeCodeEntryPolicy("private")}
            >
              <Glyph name="lock" size={19} />
              <Cap k="host.policy.private" />
            </button>
          </Tooltip>
        </span>
        {activeCodeEntryPolicy === "private" ? (
          <Tooltip kind={passwordOpen ? "hint-collapse" : "hint-password"} align="end"
            text={vis ? undefined : `${t(passwordOpen ? "host.password.settingsHide" : "host.password.setAction")}\n${t(viewerPasswordEnabled ? "host.password.set" : "host.password.unset")}`}>
            <button
              type="button"
              className="lr-btn"
              aria-label={t(passwordOpen ? "host.password.settingsHide" : "host.password.setAction")}
              aria-expanded={passwordOpen}
              aria-controls="host-password-form"
              onClick={() => setPasswordOpen((current) => !current)}
            >
              <Glyph name="key" size={19} />
              {viewerPasswordEnabled ? (
                <i className="lr-chip-dot" aria-hidden="true" />
              ) : null}
              <Cap k="join.password" />
            </button>
          </Tooltip>
        ) : null}
        {!inviteAvailable && activeCodeEntryPolicy !== null ? (
          <Pill
            icon="link"
            label={t(
              activeCodeEntryPolicy === "open"
                ? "host.invite.emptyOpen"
                : viewerPasswordEnabled
                  ? "host.invite.emptyPassword"
                  : "host.invite.emptyPrivate",
            )}
            comic="hint-invite-link"
            tone="off"
          />
        ) : null}
      </RowGroup>
      {activeCodeEntryPolicy === "private" && passwordOpen ? (
        <RowGroup>
          <form
            id="host-password-form"
            style={{ display: "contents" }}
            onSubmit={(event) => {
              event.preventDefault();
              void changeViewerPassword(viewerPasswordDraft);
            }}
          >
            <span
              className="lr-input is-password"
              style={{ flex: 1 }}
            >
              <Glyph name="key" size={17} />
              <input
                id="viewer-password"
                type={viewerPasswordVisible ? "text" : "password"}
                value={viewerPasswordDraft}
                maxLength={MAX_VIEWER_PASSWORD_LENGTH}
                autoComplete="new-password"
                placeholder={
                  vis
                    ? ""
                    : viewerPasswordEnabled
                      ? t("host.password.inputPlaceholder")
                      : t("host.password.placeholder")
                }
                aria-label={t("join.password")}
                autoFocus={!viewerPasswordEnabled}
                disabled={roomMutating}
                onChange={(event) =>
                  setViewerPasswordDraft(event.target.value)
                }
              />
            </span>
            {viewerPasswordEnabled && viewerPasswordDraft.length > 0 ? (
              <Btn
                icon={viewerPasswordVisible ? "eyeOff" : "eye"}
                hint={viewerPasswordVisible ? "hint-password-hide" : "hint-password-show"}
                title={
                  viewerPasswordVisible
                    ? "host.password.hide"
                    : "host.password.show"
                }
                draw="host-password-eye"
                pressed={viewerPasswordVisible}
                disabled={roomMutating}
                onClick={() =>
                  setViewerPasswordVisible((current) => !current)
                }
              />
            ) : null}
            <Btn
              icon="check"
              type="submit"
              title={
                viewerPasswordEnabled
                  ? "host.password.changeAction"
                  : "host.password.setAction"
              }
              hint="hint-password"
              disabled={
                roomMutating ||
                viewerPasswordDraft.length === 0 ||
                (viewerPasswordEnabled &&
                  viewerPasswordDraft === savedPassword)
              }
            />
            {viewerPasswordEnabled ? (
              <Btn
                icon="x"
                tone="danger"
                title="host.password.remove"
                hint="hint-password-remove"
                disabled={roomMutating}
                onClick={() => void changeViewerPassword(null)}
              />
            ) : null}
          </form>
        </RowGroup>
      ) : null}
    </Row>
  );
}
