import type { ParticipationType } from "../types";

export type NodeStatus = "idle" | "discovered" | "selected" | "rejected" | "confirmed";

export interface NetworkNode {
  id: string;
  name: string;
  participation_type: ParticipationType;
}

export interface DiagramPulse {
  key: number;
  edge: "bap-gateway" | `gateway-${string}`;
  tone: "amber" | "green" | "rust";
}

const TONE_STROKE: Record<DiagramPulse["tone"], string> = {
  amber: "var(--color-amber)",
  green: "var(--color-green)",
  rust: "var(--color-rust)",
};

const STATUS_BORDER: Record<NodeStatus, string> = {
  idle: "border-border",
  discovered: "border-cyan-border",
  selected: "border-amber",
  rejected: "border-rust",
  confirmed: "border-green",
};

const STATUS_RING: Record<NodeStatus, string> = {
  idle: "",
  discovered: "ring-1 ring-cyan-border",
  selected: "shadow-[0_0_0_3px_var(--color-amber-dim)]",
  rejected: "shadow-[0_0_0_3px_var(--color-rust-dim)]",
  confirmed: "shadow-[0_0_0_3px_var(--color-green-dim)]",
};

function yFor(index: number, total: number): number {
  if (total <= 1) return 50;
  const span = Math.min(78, 14 * total);
  const top = 50 - span / 2;
  return top + (span * index) / (total - 1);
}

export default function NetworkDiagram({
  nodes,
  bapId,
  statusByNode,
  pulse,
}: {
  nodes: NetworkNode[];
  bapId: string;
  statusByNode: Record<string, NodeStatus>;
  pulse: DiagramPulse | null;
}) {
  const bapPos = { x: 9, y: 50 };
  const gwPos = { x: 50, y: 50 };
  const bppPositions = nodes.map((n, i) => ({
    node: n,
    x: 91,
    y: yFor(i, nodes.length),
  }));

  const height = Math.max(320, nodes.length * 76);

  return (
    <div
      className="relative w-full rounded-xl border border-border bg-panel shadow-sm"
      style={{ height }}
    >
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        {/* static topology */}
        <line
          x1={bapPos.x}
          y1={bapPos.y}
          x2={gwPos.x}
          y2={gwPos.y}
          stroke="var(--color-border)"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
        {bppPositions.map(({ node, x, y }) => (
          <line
            key={node.id}
            x1={gwPos.x}
            y1={gwPos.y}
            x2={x}
            y2={y}
            stroke="var(--color-border)"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/* active pulse overlay */}
        {pulse &&
          (() => {
            const [a, b] =
              pulse.edge === "bap-gateway"
                ? [bapPos, gwPos]
                : [gwPos, bppPositions.find((p) => `gateway-${p.node.id}` === pulse.edge) ?? gwPos];
            return (
              <line
                key={pulse.key}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={TONE_STROKE[pulse.tone]}
                strokeWidth={2.5}
                strokeDasharray="6 4"
                vectorEffect="non-scaling-stroke"
                className="pulse-active"
              />
            );
          })()}
      </svg>

      {/* BAP node */}
      <div
        className="absolute -translate-x-1/2 -translate-y-1/2"
        style={{ left: `${bapPos.x}%`, top: `${bapPos.y}%` }}
      >
        <div className="w-28 rounded-lg border border-cyan-border bg-cyan-dim px-3 py-2 text-center shadow-sm">
          <div className="text-[10px] font-medium uppercase tracking-wider text-cyan/80">You</div>
          <div className="truncate font-mono text-[11px] text-text-dim" title={bapId}>
            {bapId}
          </div>
        </div>
      </div>

      {/* Gateway / Registry node */}
      <div
        className="absolute -translate-x-1/2 -translate-y-1/2"
        style={{ left: `${gwPos.x}%`, top: `${gwPos.y}%` }}
      >
        <div className="w-32 rounded-lg border border-amber-border bg-amber-dim px-3 py-2 text-center shadow-sm">
          <div className="text-[10px] font-medium uppercase tracking-wider text-amber/80">
            Network
          </div>
          <div className="text-[11px] text-text-dim">Gateway / Registry</div>
        </div>
      </div>

      {/* BPP nodes */}
      {bppPositions.map(({ node, x, y }) => {
        const status = statusByNode[node.id] ?? "idle";
        const isDiscoveryOnly = node.participation_type === "discovery_only";
        return (
          <div
            key={node.id}
            className="absolute -translate-x-full -translate-y-1/2"
            style={{ left: `${x}%`, top: `${y}%` }}
          >
            <div
              key={`${node.id}-${status}`}
              className={[
                "node-flash w-44 rounded-lg bg-panel-raised px-3 py-2 text-right shadow-sm transition-colors",
                isDiscoveryOnly ? "border border-dashed" : "border",
                STATUS_BORDER[status],
                STATUS_RING[status],
              ].join(" ")}
              style={
                {
                  "--flash-color":
                    status === "confirmed"
                      ? "var(--color-green)"
                      : status === "rejected"
                        ? "var(--color-rust)"
                        : "var(--color-amber)",
                } as React.CSSProperties
              }
            >
              <div className="flex items-center justify-end gap-1.5">
                {isDiscoveryOnly && (
                  <span className="rounded border border-rust-border bg-rust-dim px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-rust">
                    discovery only
                  </span>
                )}
                <span className="truncate text-[13px] font-medium text-text">{node.name}</span>
              </div>
              <div className="font-mono text-[10px] text-text-faint">{node.id}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
