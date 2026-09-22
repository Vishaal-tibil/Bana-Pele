import { useEffect, useRef, useState } from "react";
import JsonView from "./JsonView";

export interface LogLine {
  id: number;
  text: string;
  tone: "info" | "amber" | "green" | "rust";
}

/** Backend-agnostic technical trace entry -- App.tsx maps whatever shape
 * the live backend's log endpoint returns into this. */
export interface TraceEntry {
  id: string | number;
  label: string;
  payload: unknown;
}

export interface StepSummary {
  title: string;
  tone: "info" | "amber" | "green" | "rust";
  facts: { label: string; value: string }[];
}

const TONE_DOT: Record<LogLine["tone"], string> = {
  info: "bg-text-faint",
  amber: "bg-amber",
  green: "bg-green",
  rust: "bg-rust",
};

const TONE_CARD: Record<StepSummary["tone"], string> = {
  info: "border-border bg-panel-raised",
  amber: "border-amber-border bg-amber-dim",
  green: "border-green-border bg-green-dim",
  rust: "border-rust-border bg-rust-dim",
};

const TONE_TEXT: Record<StepSummary["tone"], string> = {
  info: "text-text",
  amber: "text-amber",
  green: "text-green",
  rust: "text-rust",
};

export default function RightPanel({
  steps,
  summary,
  currentResponse,
  rawLog,
}: {
  steps: LogLine[];
  summary: StepSummary | null;
  currentResponse: unknown;
  rawLog: TraceEntry[];
}) {
  const [tab, setTab] = useState<"summary" | "trace">("summary");
  const [showRaw, setShowRaw] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [steps.length]);

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-border-soft bg-panel">
      <div className="flex-1 min-h-0 overflow-y-auto border-b border-border-soft">
        <div className="sticky top-0 z-10 border-b border-border-soft bg-panel px-4 py-2.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-text-dim">
            What's happening
          </h2>
        </div>
        <div className="px-4 py-3">
          {steps.length === 0 && (
            <p className="py-4 text-sm text-text-faint italic">
              Start a session on the left to begin.
            </p>
          )}
          <ul className="space-y-2.5">
            {steps.map((s) => (
              <li key={s.id} className="fade-in-up flex items-start gap-2.5 text-[13.5px] leading-snug">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[s.tone]}`} />
                <span className="text-text">{s.text}</span>
              </li>
            ))}
          </ul>
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="flex h-[46%] min-h-[240px] flex-col">
        <div className="flex items-center justify-between border-b border-border-soft px-4 py-2">
          <div className="flex gap-1 text-[11px]">
            <button
              onClick={() => setTab("summary")}
              className={`rounded px-2.5 py-1 font-medium transition-colors ${
                tab === "summary"
                  ? "bg-border-soft text-text"
                  : "text-text-faint hover:text-text-dim"
              }`}
            >
              Summary
            </button>
            <button
              onClick={() => setTab("trace")}
              className={`rounded px-2.5 py-1 font-medium transition-colors ${
                tab === "trace" ? "bg-border-soft text-text" : "text-text-faint hover:text-text-dim"
              }`}
            >
              Technical trace ({rawLog.length})
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {tab === "summary" ? (
            summary ? (
              <div className="fade-in-up space-y-3">
                <div className={`rounded-lg border px-3.5 py-3 ${TONE_CARD[summary.tone]}`}>
                  <div className={`text-sm font-semibold ${TONE_TEXT[summary.tone]}`}>
                    {summary.title}
                  </div>
                  {summary.facts.length > 0 && (
                    <dl className="mt-2 space-y-1">
                      {summary.facts.map((f) => (
                        <div key={f.label} className="flex gap-2 text-[12.5px]">
                          <dt className="w-28 shrink-0 text-text-faint">{f.label}</dt>
                          <dd className="min-w-0 break-words font-medium text-text">{f.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
                <button
                  onClick={() => setShowRaw((v) => !v)}
                  className="text-[11px] font-medium text-text-faint underline decoration-dotted underline-offset-2 hover:text-text-dim"
                >
                  {showRaw ? "Hide raw response JSON" : "Show raw response JSON"}
                </button>
                {showRaw && (
                  <div className="rounded-lg border border-border-soft bg-bg px-3 py-2.5">
                    <JsonView data={currentResponse} />
                  </div>
                )}
              </div>
            ) : (
              <span className="text-sm italic text-text-faint">Nothing to show yet.</span>
            )
          ) : rawLog.length === 0 ? (
            <span className="text-sm italic text-text-faint">No messages exchanged yet.</span>
          ) : (
            <div className="space-y-3">
              {rawLog.map((entry) => (
                <div key={entry.id} className="rounded-lg border border-border-soft bg-bg px-3 py-2.5">
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-text-faint">
                    {entry.label}
                  </div>
                  <JsonView data={entry.payload} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
