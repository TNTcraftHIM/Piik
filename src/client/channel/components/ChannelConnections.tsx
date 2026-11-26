import { useEffect, useId, useRef, useState } from "react";
import type { ChannelController, ChannelConnectionSample } from "../types";
import type { ChannelSnapshot, ChannelTopology } from "../protocol";
import { Btn } from "../../components/living/primitives";
import { FloatingPanel } from "../../components/living/FloatingPanel";
import { ConnectionDetails } from "../../components/living/ConnectionDetails";
import { RouteGraph } from "../../components/living/RouteGraph";
import { LoadingStatus } from "../../components/living/WaitingStatus";
import { Glyph } from "../../ui/icons";
import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { useCopy } from "../../ui/copy";
import { channelConnectionGraph, channelConnectionRows, connectionSessionName, hasSelectedLocalDisplay } from "./channel-connection-data";
import { collectNativeConnectionMetrics, type NativeMetricSamples } from "../native-connection-metrics";
import { useSurfaceDocument } from "../../ui/panel-window";
import "./channel-connections.css";
import "./channel-room-controls.css";

interface Observations {
  scope: string;
  topology: ChannelTopology | null;
  metrics: ChannelConnectionSample[];
  unavailable: Array<"connection.topologyUnavailable" | "connection.browserMetricsUnavailable" | "connection.appMetricsUnavailable">;
}

/** Both kinds of media retain the shared four-group metric presentation. */
export function ChannelConnectionReport({ state, roomId, sessionId, topology, metrics, showEmpty = true }: {
  state: ChannelSnapshot; roomId: string; sessionId: string; topology: ChannelTopology | null;
  metrics: readonly ChannelConnectionSample[]; showEmpty?: boolean;
}) {
  const { t } = useCopy();
  const graph = topology ? channelConnectionGraph(state, roomId, sessionId, topology, t) : null;
  const rows = channelConnectionRows(state, sessionId, topology, metrics, t);
  return <div className="c3-connection-report">
    {!!graph?.endpointGroups.length && <details open className="c3-connection-identities c3-settings-details">
      <summary>{t("connection.samePersonEndpoints")}</summary>
      <dl>{graph.endpointGroups.map(group => <div key={group.userId} style={{ borderInlineStartColor: participantColor(group.userId) }}>
        <dt><PawnSvg color={participantColor(group.userId)} identity={group.userId} /><span>{group.name}</span></dt>
        <dd>{group.endpoints.join(" / ")}</dd>
      </div>)}</dl>
    </details>}
    {graph && <RouteGraph {...graph} label={topology?.screen ? undefined : t("connection.room")}
      emptyLabel={t(topology?.screen ? "connection.noScreenPath" : "connection.noRoomLinks")} />}
    {!!graph?.edges.length && <p className="c3-connection-note">{t(topology?.screen ? "connection.pathLegend" : "connection.roomLinkLegend")}</p>}
    {hasSelectedLocalDisplay(topology, sessionId)
      && <p className="c3-connection-note">{t("connection.localDisplayHint")}</p>}
    {metrics.some(sample => sample.ownerSessionId !== sessionId && sample.media === "video")
      && <p className="c3-connection-note">{t("connection.appMetricScope")}</p>}
    <ConnectionDetails rows={rows} />
    {showEmpty && !rows.length && <p className="c3-connection-note">{t("connection.noMedia")}</p>}
  </div>;
}

function ConnectionBody({ channel, roomId, active }: { channel: ChannelController; roomId: string; active: boolean }) {
  const { t } = useCopy();
  const ownerDocument = useSurfaceDocument();
  const [publication, setPublication] = useState<string>();
  const [result, setResult] = useState<Observations>();
  const current = useRef(channel);
  current.current = channel;
  const state = channel.state, sessionId = channel.sessionId;
  const room = state?.channel.rooms.find(room => room.id === roomId);
  const screens = state?.publications.filter(publication => publication.roomId === roomId && publication.kind === "screen") ?? [];
  const initial = screens.find(screen => channel.screenInputs.has(screen.id)) ?? screens.find(screen => channel.ownedScreens.has(screen.id)) ?? screens[0];
  const selected = publication === undefined ? initial?.id ?? "" : screens.some(screen => screen.id === publication) ? publication : "";
  const scope = JSON.stringify([state?.channel.id, channel.self?.id, sessionId, roomId, room?.delivery?.bindingId,
    selected, screens.find(screen => screen.id === selected)?.sessionId, channel.appConnected]);
  useEffect(() => {
    if (!active || !ownerDocument || !room?.authorized || !room.available || !room.delivery) return;
    let stop = () => {};
    const refresh = () => {
      stop();
      if (ownerDocument.visibilityState !== "visible") return;
      const lifetime = new AbortController();
      const nativePrevious: NativeMetricSamples = new Map();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = async () => {
        const owner = current.current;
        const [topology, metrics, native] = await Promise.allSettled([
          owner.roomTopology(roomId, selected || undefined, lifetime.signal),
          owner.connectionMetrics(roomId, selected || undefined),
          owner.appConnected ? owner.appConnectionMetrics(roomId, selected || undefined, lifetime.signal) : Promise.resolve(null),
        ]);
        if (lifetime.signal.aborted) return;
        const browser = metrics.status === "fulfilled" ? metrics.value.samples.map(sample => ({ ...sample,
          ownerSessionId: sessionId!, connectionId: sample.pairId, selected: true })) : [];
        const app = native.status === "fulfilled" && native.value ? collectNativeConnectionMetrics(native.value, nativePrevious) : [];
        if (native.status === "rejected") nativePrevious.clear();
        const samples = [...browser, ...app].filter(sample => selected || owner.state?.publications.some(publication =>
          publication.id === sample.publicationId && publication.kind === "voice"));
        const graph = topology.status === "fulfilled" ? topology.value : null;
        const appExpected = hasSelectedLocalDisplay(graph, sessionId!);
        const unavailable: Observations["unavailable"] = [];
        if (topology.status === "rejected") unavailable.push("connection.topologyUnavailable");
        if (metrics.status === "rejected" || metrics.value.unavailable) unavailable.push("connection.browserMetricsUnavailable");
        if (native.status === "rejected" || appExpected && !owner.appConnected) unavailable.push("connection.appMetricsUnavailable");
        setResult({ scope, topology: graph, metrics: samples, unavailable });
        timer = setTimeout(read, 1000);
      };
      void read();
      stop = () => { lifetime.abort(); clearTimeout(timer); };
    };
    ownerDocument.addEventListener("visibilitychange", refresh);
    refresh();
    return () => { stop(); ownerDocument.removeEventListener("visibilitychange", refresh); };
  }, [active, scope, room?.authorized, room?.available, ownerDocument]);
  const observation = result?.scope === scope ? result : null;
  return <>
    <label className="c3-connection-scope"><span>{t("connection.scope")}</span>
      <select className="lr-select" aria-label={t("connection.scope")} value={selected} onChange={event => setPublication(event.target.value)}>
        <option value="">{t("connection.room")}</option>
        {screens.map(screen => <option key={screen.id} value={screen.id}>
          {state && connectionSessionName(state, screen.sessionId, t)}
        </option>)}
      </select>
    </label>
    {!room?.available || !room.authorized || !room.delivery
      ? <p className="c3-connection-note" role="status"><Glyph name="alert" size={16} />
        <span>{t("connection.unavailable")}</span></p>
      : !observation && <LoadingStatus label="connection.loading" />}
    {observation?.unavailable.map(reason => <p className="c3-connection-note" role="status" key={reason}>
      <Glyph name="alert" size={16} /><span>{t(reason)}</span></p>)}
    {room?.authorized && room.available && state && sessionId && observation && <ChannelConnectionReport state={state} roomId={roomId} sessionId={sessionId}
      topology={observation.topology} metrics={observation.metrics} showEmpty={!observation.unavailable.length} />}
  </>;
}

export function ChannelConnections({ channel, roomId }: { channel: ChannelController; roomId: string }) {
  const { t } = useCopy();
  const id = useId(), trigger = `${id}-trigger`;
  const [open, setOpen] = useState(false);
  const roomName = channel.state?.channel.rooms.find(room => room.id === roomId)?.name;
  const title = roomName ? t("connection.roomDetails", { room: roomName }) : t("host.details");
  return <>
    <Btn id={trigger} icon="gauge" quiet size="compact" title={{ text: title }}
      hint="hint-details" expanded={open} controls={id} popoverTarget={id} />
    <FloatingPanel id={id} trigger={trigger} title={title} detachable className="c3-connections"
      onOpenChange={setOpen}>
      <ConnectionBody channel={channel} roomId={roomId} active={open} />
    </FloatingPanel>
  </>;
}
