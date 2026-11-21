import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { activateClient, clientLaunchURL, isClientActivated, watchClientActivation } from "../../lib/app-launch";
import { useProjectLink } from "../../lib/use-project-link";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Tooltip } from "./Tooltip";
import { Comic } from "./Comic";
import { HintComic } from "./hints";
import { LoadingStatus } from "./WaitingStatus";
import { useAnchoredPopover } from "./use-anchored-popover";
import { androidAppIntent } from "../../native/activation";
import type { AppDiscovery } from "../../native/discovery";
import type { AppReleaseIdentity } from "../../lib/release-update";
import { useReleaseUpdate } from "../../lib/use-release-update";
import { AppReleaseNotice } from "./AppReleaseNotice";
import { channelAppDiscovery } from "../../channel/app-link";
import { OpenInClient } from "./OpenInClient";
import { currentTheme, subscribeTheme } from "../../ui/theme";
import type {} from "../../ui/native-window";

interface AppConnectionProps {
  onConnected?: (health: NonNullable<Awaited<ReturnType<AppDiscovery["health"]>>>, signal: AbortSignal) => void | Promise<void>;
  discovery?: AppDiscovery;
  /** A current control connection, supplied by its owning session. */
  connected?: boolean;
  /** The owning Site must be admitted before App control can start. */
  available?: boolean;
  targetURL?: string;
  wakeURL?: string | null;
}

interface ConnectionAttempt {
  controller: AbortController;
  popup: Window | null;
  automatic: boolean;
  open?: () => void;
  cancel?: () => void;
}

export function AppConnectionButton({ onConnected, discovery = channelAppDiscovery, connected, available = true, targetURL, wakeURL: launchTarget }: AppConnectionProps) {
  const { lang, t } = useCopy();
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, currentTheme);
  const [state, setState] = useState<"idle" | "waking" | "busy" | "approval" | "approving" | "ready" | "unavailable" | "incompatible">("idle");
  const wakeURL = launchTarget === undefined ? androidAppIntent("piik://app") : launchTarget;
  const [helpOpen, setHelpOpen] = useState(false);
  const downloadURL = useProjectLink("/#download", "https://github.com/TNTcraftHIM/Piik/releases/latest", helpOpen);
  const helpId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const help = useRef<HTMLDivElement>(null);
  useAnchoredPopover(trigger, help);
  const pending = useRef<ConnectionAttempt | null>(null);
  const healthCheck = useRef<AbortController | null>(null);
  const automaticFailed = useRef(false);
  const [automaticHint, setAutomaticHint] = useState(false);
  const [build, setBuild] = useState<AppReleaseIdentity>();
  const [management, setManagement] = useState<{ url: string; updateSupported: boolean }>();
  const { update: release, refresh: checkRelease } = useReleaseUpdate(build);
  function rememberBuild(health: (Partial<AppReleaseIdentity> & { updateSupported?: boolean; managementURL?: string }) | null) {
    setManagement(health?.managementURL ? { url: health.managementURL, updateSupported: health.updateSupported === true } : undefined);
    setBuild(health?.version && health.revision
      ? { version: health.version, revision: health.revision, packageTarget: health.packageTarget } : undefined);
  }
  useEffect(() => () => {
    pending.current?.controller.abort(); pending.current?.popup?.close(); pending.current = null;
  }, []);
  useEffect(() => {
    if (!available) {
      pending.current?.controller.abort(); pending.current?.popup?.close(); pending.current = null;
      setState("idle");
    } else if (!connected && !automaticFailed.current) void connect(false, true);
  }, [available, connected]);
  useEffect(() => {
    if (connected === false) rememberBuild(null);
    const refresh = async (returned = false) => {
      if (!available || pending.current || (automaticFailed.current && !connected)) return;
      if (returned && connected === false && isClientActivated()) {
        await connect(false, true);
        return;
      }
      if (connected) setState("ready");
      if (help.current?.matches(":popover-open") || (!connected && !isClientActivated())) return;
      healthCheck.current?.abort();
      const current = healthCheck.current = new AbortController();
      const native = discovery;
      if (current.signal.aborted) return;
      try {
        const health = await native.health({ signal: current.signal, waitForPermission: false });
        if (!current.signal.aborted && !pending.current) {
          rememberBuild(health);
          if (!connected) setState(health ? "ready" : "idle");
        }
      } catch (error) {
        if (!current.signal.aborted && !pending.current) {
          rememberBuild(null);
          if (!connected) setState("idle");
        }
      }
    };
    // Launch/remembered activation is intent, not proof of current permission.
    // Recheck on return without keeping a media session or a polling timer alive.
    const onFocus = () => { void refresh(true).catch(() => undefined); };
    const onVisible = () => { if (document.visibilityState === "visible") onFocus(); };
    void refresh().catch(() => undefined);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const unwatch = watchClientActivation(onFocus);
    return () => {
      healthCheck.current?.abort(); window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible); unwatch();
    };
  }, [discovery, connected, available]);

  function showHelp(): void {
    if (trigger.current) help.current?.showPopover({ source: trigger.current });
  }

  function bookmarksURL(value: string): string {
    const destination = new URL(value);
    destination.searchParams.delete("site");
    destination.searchParams.set("bookmarks", "1");
    destination.hash = new URLSearchParams({ site: window.location.origin, "piik-client": "1" }).toString();
    return clientLaunchURL(destination.href, { lang, theme, explicit: window.piikNativeWindow ? ["copy"] : ["copy", "theme"] });
  }

  async function connect(wake = false, automatic = false): Promise<void> {
    if (!available) return;
    if (!automatic) setAutomaticHint(false);
    if (pending.current) {
      if (!automatic) {
        pending.current.automatic = false;
        if (!pending.current.open) showHelp();
      }
      pending.current.open?.(); return;
    }
    healthCheck.current?.abort();
    // Discovery and its browser permission prompt stay in the current tab.
    // A fresh click opens the real approval page without reserving a blank tab.
    const attempt: ConnectionAttempt = { controller: new AbortController(), popup: null, automatic };
    pending.current = attempt;
    if (!automatic) showHelp();
    const signal = attempt.controller.signal;
    let native: AppDiscovery | undefined;
    let approving = false;
    let waking = false;
    const verifyApproval = async (reported = false) => {
      if (approving || signal.aborted) return;
      approving = true;
      const health = await native?.health({ signal }).catch(() => null);
      if (signal.aborted) return;
      approving = false;
      if (health) {
        rememberBuild(health);
        try { await activate(health); }
        catch (error) { if (!signal.aborted) finish(native?.isIncompatible(error) ? "incompatible" : "unavailable"); }
      } else if (reported) finish("unavailable");
      else if (attempt.popup?.closed) finish("idle");
    };
    const onMessage = (event: MessageEvent) => {
      if (!attempt.popup || event.source !== attempt.popup || !approvalOrigin || event.origin !== approvalOrigin ||
          event.data?.type !== "piik-app-approved" || event.data.site !== window.location.origin) return;
      // A message or browser return asks us to verify App-owned permission.
      void verifyApproval(true);
    };
    let approvalOrigin = "";
    const finish = (result: typeof state) => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      attempt.controller.abort();
      attempt.popup?.close();
      if (pending.current === attempt) {
        pending.current = null;
        automaticFailed.current = result !== "ready";
        const failed = result === "unavailable" || result === "incompatible";
        setAutomaticHint(false);
        setState(attempt.automatic && failed ? "idle" : result);
        if (!attempt.automatic && failed) showHelp();
        else help.current?.hidePopover();
      }
    };
    const activate = async (health: NonNullable<Awaited<ReturnType<AppDiscovery["health"]>>>) => {
      if (onConnected) {
        // One attempt owns discovery, approval and the control handshake.
        attempt.popup?.close();
        attempt.popup = null;
        setState("busy");
        await onConnected(health, signal);
        signal.throwIfAborted();
      }
      if (pending.current !== attempt) return;
      activateClient();
      finish("ready");
    };
    attempt.cancel = () => finish("idle");
    const onFocus = () => {
      if (waking) { attempt.open?.(); return; }
      if (attempt.popup) void verifyApproval();
    };
    const onVisible = () => { if (document.visibilityState === "visible") onFocus(); };
    window.addEventListener("message", onMessage);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    signal.addEventListener("abort", () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    }, { once: true });
    const discover = async () => {
      setState("busy");
      try {
        native = discovery;
        if (signal.aborted) return;
        const url = await native.connect({ signal, waitForPermission: !attempt.automatic });
        if (signal.aborted) return;
        if (!url) { finish("unavailable"); return; }
        // A compatible App was found; health may only see an older, approved App.
        const health = await native.health({ signal, waitForPermission: false }).catch(error => {
          if (native?.isIncompatible(error)) return null;
          throw error;
        });
        if (signal.aborted) return;
        rememberBuild(health);
        if (health) {
          await activate(health);
          return;
        }
        approvalOrigin = new URL(url).origin;
        attempt.open = () => {
          if (signal.aborted || attempt.popup) return;
          attempt.popup = window.open(url, "_blank");
          if (!attempt.popup) { finish("unavailable"); return; }
          attempt.open = undefined;
          setState("approving"); help.current?.hidePopover();
        };
        setAutomaticHint(attempt.automatic);
        setState("approval");
      } catch (error) {
        if (!signal.aborted) finish(native?.isIncompatible(error) ? "incompatible" : "unavailable");
      }
    };
    if (wake && wakeURL) {
      waking = true;
      attempt.open = () => {
        if (!waking || signal.aborted) return;
        waking = false;
        attempt.open = undefined;
        void discover();
      };
      setState("waking");
      window.location.assign(wakeURL);
    } else await discover();
  }

  const busy = state === "busy" || state === "waking" || state === "approving";
  const ready = state === "ready" && connected !== false;
  const label = t(({
    idle: "client.connect.action",
    waking: "client.connect.returnToBrowser",
    busy: "client.connect.discovering",
    approval: "client.connect.found",
    approving: "client.connect.approving",
    ready: connected === false ? "client.connect.action" : "client.connect.manage",
    unavailable: "client.connect.unavailable",
    incompatible: "native.incompatible",
  } as const)[state]);
  const failed = state === "unavailable" || state === "incompatible";
  const update = ready ? release : null;
  const availableUpdate = update?.kind === "update-available" || update?.kind === "major-update";
  const title = availableUpdate ? t("client.connect.update", { current: build!.version, version: update.version }) : label;
  return <><Tooltip kind={availableUpdate ? "update-available" : ready ? "hint-app-ready" : state === "unavailable" ? "signal-failed" : state === "incompatible" ? "warning" : "hint-client-site"}
    text={state === "idle" ? t("client.connect.hint") : title} disabled={helpOpen}
    autoOpen={automaticHint} place="below" align="end">
    <button ref={trigger} type="button" className={`lr-btn is-compact lr-app-connect${ready ? " is-ready is-quiet" : ""}`}
      aria-label={title} aria-busy={busy || undefined} data-update={availableUpdate || undefined}
      popoverTarget={ready || failed || state === "approval" ? helpId : undefined} aria-haspopup="dialog"
      onClick={ready || failed || state === "approval" ? undefined : event => {
        // Failure may attach popoverTarget during this click; do not toggle the
        // recovery card closed immediately after opening it.
        event.preventDefault();
        checkRelease();
        void connect();
      }} disabled={!available}>
      <Glyph name={availableUpdate ? "arrowUp" : ready ? "check" : busy ? "loader" : state === "unavailable" || state === "incompatible" ? "alert" : "window"}
        size={16} className={busy ? "lr-spin" : undefined} />
      <span className="lr-cap">App</span>
    </button>
  </Tooltip>
    {ready && management && window.piikNativeWindow !== "integrated" && <a className="lr-btn is-compact is-quiet" href={bookmarksURL(management.url)}
      target="_blank" rel="noopener noreferrer" aria-label={t("client.launcher.manageSites")}>
      <Glyph name="star" size={16} /><span className="lr-cap">{t("client.launcher.manageSites")}</span>
    </a>}
    <div ref={help} id={helpId} popover="auto" role="dialog" aria-label={t("client.connect.action")} aria-describedby={`${helpId}-message`}
      className="lr-anchored-card lr-app-connect-help" onToggle={event => {
        setHelpOpen(event.newState === "open");
        if (event.newState === "closed" && !pending.current?.popup) pending.current?.cancel?.();
        if (event.newState !== "open" || !trigger.current) return;
        if (ready) checkRelease();
        event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus();
      }}>
      <div className="lr-app-connect-head">
        {state === "busy" ? <LoadingStatus label="client.connect.discovering" /> :
          <div className="lr-app-connect-scene" aria-hidden="true">{helpOpen && (ready ? <HintComic kind="hint-app-ready" /> : state === "approval" || state === "waking" || state === "ready" ? <HintComic kind="hint-client-site" /> :
            <Comic kind={state === "approving" ? "signal-connecting" : state === "incompatible" ? "warning" : "signal-failed"} theme="paper" />)}</div>}
        <button type="button" className="lr-btn is-dense is-quiet lr-app-connect-close" aria-label={t("common.close")}
          popoverTarget={helpId} popoverTargetAction="hide">
          <Glyph name="x" size={16} />
        </button>
      </div>
      <p id={`${helpId}-message`}>{state === "busy" ? t("client.connect.permissionHint") : label}</p>
      {state === "ready" && build && <p className="lr-app-connect-version">
        <span>{t("client.launch.version", { version: build.version })}</span>

      </p>}
      {update && <AppReleaseNotice update={update} managementURL={management?.updateSupported ? management.url : undefined} />}
      <div className="lr-app-connect-actions">
        {!ready && state !== "busy" && state !== "approving" && <button type="button" className="lr-btn" aria-label={t(state === "approval" ? "client.connect.open" : state === "waking" ? "client.connect.continue" : "common.retry")} onClick={() => void connect()}>
          <Glyph name={state === "approval" ? "arrowRight" : "refresh"} size={16} /><span>{t(state === "approval" ? "client.connect.open" : state === "waking" ? "client.connect.continue" : "common.retry")}</span>
        </button>}
        {failed && wakeURL && <a className="lr-btn" href={wakeURL} onClick={event => { event.preventDefault(); void connect(true); }}>
          <Glyph name="window" size={16} /><span>{t("client.connect.wakeApp")}</span>
        </a>}
        {failed && <a className="lr-btn" href={downloadURL} target="_blank" rel="noopener noreferrer" aria-label={t("client.connect.download")}>
          <Glyph name="arrowDown" size={16} /><span>{t("client.connect.download")}</span>
        </a>}
      </div>
      {targetURL && !(typeof window !== "undefined" && window.piikNativeWindow) && <OpenInClient
        discovery={discovery} targetURL={targetURL} active={helpOpen} disabled={busy} downloadURL={downloadURL} />}
      {state !== "ready" && <p className="lr-app-connect-optional">{t("client.connect.browserHint")}</p>}
    </div>
  </>;
}
