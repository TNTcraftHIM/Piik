import { Check, CircleHelp, LoaderCircle, Network, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import {
  runConnectionSelfCheck,
  type ConnectionProbeResult,
  type ConnectionSelfCheckResult,
} from "../media/connection-self-check";

const labels: Record<keyof ConnectionSelfCheckResult, string> = {
  site: "站点",
  signaling: "信令",
  stun: "STUN",
  sfu: "SFU/UDP",
};

function ProbeIcon({ result }: { result: ConnectionProbeResult }) {
  if (result.status === "passed") return <Check size={14} aria-hidden="true" />;
  if (result.status === "failed") return <X size={14} aria-hidden="true" />;
  return <CircleHelp size={14} aria-hidden="true" />;
}

export function ConnectionSelfCheck() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ConnectionSelfCheckResult | null>(null);
  const runGeneration = useRef(0);
  const controller = useRef<AbortController | null>(null);
  useLayoutEffect(
    () => () => {
      ++runGeneration.current;
      controller.current?.abort();
      controller.current = null;
    },
    [],
  );

  async function run(): Promise<void> {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    const generation = ++runGeneration.current;
    setRunning(true);
    try {
      const next = await runConnectionSelfCheck({
        signal: nextController.signal,
      });
      if (
        !nextController.signal.aborted &&
        runGeneration.current === generation
      ) {
        setResult(next);
      }
    } finally {
      if (controller.current === nextController) {
        controller.current = null;
        setRunning(false);
      }
    }
  }

  return (
    <div className="connection-self-check">
      <button
        className="button button-secondary"
        type="button"
        disabled={running}
        onClick={() => void run()}
      >
        {running ? (
          <LoaderCircle className="spin" size={16} aria-hidden="true" />
        ) : (
          <Network size={16} aria-hidden="true" />
        )}
        {running ? "正在自检" : "连接自检"}
      </button>
      {result && (
        <div className="connection-self-check-results" role="status">
          {(Object.keys(labels) as Array<keyof ConnectionSelfCheckResult>).map(
            (key) => (
              <div
                className={`connection-self-check-result is-${result[key].status}`}
                key={key}
              >
                <ProbeIcon result={result[key]} />
                <strong>{labels[key]}</strong>
                <span>{result[key].detail}</span>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
