import { Check, CircleAlert, Copy, Hash, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { copyRoomCode } from "./room-code";

type CopyState = "idle" | "copied" | "failed";

export function RoomCode({
  roomId,
  onReplace,
  replaceDisabled = false,
}: {
  roomId: string;
  onReplace?: () => void | Promise<void>;
  replaceDisabled?: boolean;
}) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [confirmingReplace, setConfirmingReplace] = useState(false);
  const [replacePending, setReplacePending] = useState(false);
  const resetTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  async function copy(): Promise<void> {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    try {
      await copyRoomCode(roomId);
      if (!mountedRef.current) {
        return;
      }
      setCopyState("copied");
      resetTimerRef.current = window.setTimeout(() => {
        setCopyState("idle");
        resetTimerRef.current = null;
      }, 1_500);
    } catch {
      if (mountedRef.current) {
        setCopyState("failed");
        resetTimerRef.current = window.setTimeout(() => {
          setCopyState("idle");
          resetTimerRef.current = null;
        }, 1_500);
      }
    }
  }

  async function replace(): Promise<void> {
    if (!onReplace || replacePending || replaceDisabled) {
      return;
    }
    setReplacePending(true);
    try {
      await onReplace();
    } finally {
      if (mountedRef.current) {
        setReplacePending(false);
        setConfirmingReplace(false);
      }
    }
  }

  const copyLabel =
    copyState === "copied"
      ? "房间号已复制"
      : copyState === "failed"
        ? "复制失败，请手动复制房间号"
        : `复制房间号 ${roomId}`;

  return (
    <span className="room-code" aria-label={`房间号 ${roomId}`}>
      <Hash size={15} aria-hidden="true" />
      <span className="room-code-label">房间号</span>
      <strong>{roomId}</strong>
      <span className="room-code-actions">
        {onReplace && confirmingReplace ? (
          <>
            <button
              className="room-code-copy"
              type="button"
              title={replacePending ? "正在更换房间号" : "确认更换房间号"}
              aria-label={replacePending ? "正在更换房间号" : "确认更换房间号"}
              disabled={replacePending || replaceDisabled}
              onClick={() => void replace()}
            >
              {replacePending ? (
                <RefreshCw size={15} className="spin" aria-hidden="true" />
              ) : (
                <Check size={15} aria-hidden="true" />
              )}
            </button>
            <button
              className="room-code-copy"
              type="button"
              title="取消更换房间号"
              aria-label="取消更换房间号"
              disabled={replacePending}
              onClick={() => setConfirmingReplace(false)}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </>
        ) : (
          <>
            {onReplace && (
              <button
                className="room-code-copy"
                type="button"
                title="更换房间号"
                aria-label="更换房间号"
                disabled={replaceDisabled}
                onClick={() => setConfirmingReplace(true)}
              >
                <RefreshCw size={15} aria-hidden="true" />
              </button>
            )}
            <button
              className={`room-code-copy${copyState === "failed" ? " is-failed" : ""}`}
              type="button"
              title={copyLabel}
              aria-label={copyLabel}
              onClick={() => void copy()}
            >
              {copyState === "copied" ? (
                <Check size={15} aria-hidden="true" />
              ) : copyState === "failed" ? (
                <CircleAlert size={15} aria-hidden="true" />
              ) : (
                <Copy size={15} aria-hidden="true" />
              )}
            </button>
          </>
        )}
      </span>
      <span className="visually-hidden" role="status" aria-live="polite">
        {copyState === "copied"
          ? "房间号已复制"
          : copyState === "failed"
            ? "房间号复制失败"
            : ""}
      </span>
    </span>
  );
}
