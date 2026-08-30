// LCD room code chip with copy and in-place room replacement confirmation.
import { useEffect, useRef, useState } from "react";
import type { CodeEntryPolicy } from "../../../shared/protocol";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { copyRoomCode } from "../room-code";
import { Btn, Pill } from "./primitives";
import { ComicTooltip } from "./ComicTooltip";

export function Lcd({ code }: { code: string }) {
  const { t, vis } = useCopy();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const timerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  async function copy(): Promise<void> {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    try {
      await copyRoomCode(code, (value) => navigator.clipboard.writeText(value));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    timerRef.current = window.setTimeout(() => setCopyState("idle"), 1500);
  }

  const copyFeedback =
    copyState === "copied"
      ? t("common.copied")
      : copyState === "failed"
        ? t("common.copyFailed")
        : "";

  const copyButton = (
    <button
      type="button"
      title={vis ? undefined : t("common.copy")}
      aria-label={copyFeedback || t("common.copy")}
      onClick={(event) => {
        // Hint-wrapped in vis: pointer activation must not leave the comic
        // pinned open by focus (keyboard clicks keep focus).
        if (vis && event.detail !== 0) event.currentTarget.blur();
        void copy();
      }}
    >
      <Glyph
        name={
          copyState === "copied"
            ? "check"
            : copyState === "failed"
              ? "alert"
              : "copy"
        }
        size={16}
        draw="lcd-copy"
      />
    </button>
  );

  return (
    <span
      className="lr-lcd"
      role="group"
      aria-label={`${t("common.roomCode")} ${code}`}
      title={vis ? undefined : t("common.roomCode")}
    >
      <span className="lr-lcd-roll" aria-hidden="true">
        {[...code].map((digit, index) => (
          <span key={`${code}-${index}`} style={{ animationDelay: `${index * 45}ms` }}>
            {digit}
          </span>
        ))}
      </span>
      {vis ? (
        <ComicTooltip kind="hint-copy-code">{copyButton}</ComicTooltip>
      ) : (
        copyButton
      )}
      <span className="visually-hidden" role="status" aria-live="polite">
        {copyFeedback}
      </span>
    </span>
  );
}

export function RoomChip({
  roomId,
  onReplace,
  replaceDisabled = false,
}: {
  roomId: string;
  onReplace?: () => void | Promise<void>;
  replaceDisabled?: boolean;
}) {
  const { vis } = useCopy();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  async function replace(): Promise<void> {
    if (!onReplace || pendingRef.current || replaceDisabled) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await onReplace();
    } finally {
      pendingRef.current = false;
      setPending(false);
      setConfirming(false);
    }
  }

  return (
    <>
      <Lcd code={roomId} />
      {onReplace ? (
        confirming ? (
          <>
            <Btn
              icon="check"
              title="host.roomReplaceConfirm"
              hint="hint-shuffle-code"
              disabled={pending || replaceDisabled}
              onClick={() => void replace()}
            />
            <Btn
              icon="x"
              title="common.cancel"
              hint="hint-close"
              disabled={pending}
              onClick={() => setConfirming(false)}
            />
          </>
        ) : (
          <Btn
            icon="refresh"
            title="host.roomReplace"
            cap={vis ? undefined : "host.roomReplace"}
            hint="hint-shuffle-code"
            disabled={replaceDisabled}
            onClick={() => setConfirming(true)}
          />
        )
      ) : null}
    </>
  );
}

export function RoomAdmissionBadge({
  policy,
  passwordEnabled,
}: {
  policy: CodeEntryPolicy;
  passwordEnabled: boolean;
}) {
  const { t } = useCopy();
  const presentation =
    policy === "open"
      ? {
          icon: "globe" as const,
          label: "host.policy.currentOpen" as const,
          tone: "good" as const,
          comic: "hint-policy-open" as const,
        }
      : passwordEnabled
        ? {
            icon: "key" as const,
            label: "host.policy.currentPassword" as const,
            tone: "good" as const,
            comic: "hint-password" as const,
          }
        : {
            icon: "lock" as const,
            label: "host.policy.currentInvite" as const,
            tone: undefined,
            comic: "hint-policy-private" as const,
          };
  return (
    <Pill
      icon={presentation.icon}
      tone={presentation.tone}
      label={t(presentation.label)}
      comic={presentation.comic}
    />
  );
}
