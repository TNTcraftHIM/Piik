// LCD room code chip with copy and in-place room replacement confirmation.
import { useEffect, useRef, useState } from "react";
import type { CodeEntryPolicy } from "../../../shared/protocol";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { copyRoomCode } from "../room-code";
import { Btn, Pill } from "./primitives";
import { Tooltip } from "./Tooltip";

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
      aria-label={copyFeedback || t("common.copy")}
      onClick={(event) => {
        // Pointer activation must not pin the hint open; keyboard keeps focus.
        if (event.detail !== 0) event.currentTarget.blur();
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
    >
      <span className="lr-lcd-roll" aria-hidden="true">
        {[...code].map((digit, index) => (
          <span key={`${code}-${index}`} style={{ animationDelay: `${index * 45}ms` }}>
            {digit}
          </span>
        ))}
      </span>
      <Tooltip kind={copyState === "failed" ? "copy-failed" : "hint-copy-code"}
        tone={copyState === "copied" ? "live" : copyState === "failed" ? "bad" : "off"}
        motion={copyState === "idle" ? "demo" : "still"}
        text={vis ? undefined : copyFeedback || t("common.copy")}>
        {copyButton}
      </Tooltip>
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

export function roomAdmission(policy: CodeEntryPolicy, passwordEnabled: boolean) {
  return (
    policy === "open"
      ? {
          icon: "globe" as const,
          label: "host.policy.currentOpen" as const,
          comic: "hint-admission-code" as const,
        }
      : passwordEnabled
        ? {
            icon: "key" as const,
            label: "host.policy.currentPassword" as const,
            comic: "hint-admission-password" as const,
          }
        : {
            icon: "lock" as const,
            label: "host.policy.currentInvite" as const,
            comic: "hint-admission-invite" as const,
          }
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
  const presentation = roomAdmission(policy, passwordEnabled);
  return (
    <Pill
      icon={presentation.icon}
      tone="off"
      label={t(presentation.label)}
      comic={presentation.comic}
    />
  );
}
