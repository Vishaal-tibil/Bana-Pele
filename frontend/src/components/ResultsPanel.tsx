import type { CatalogItem, Order, ParticipationType, SearchResult } from "../types";

export interface Selection {
  bppId: string;
  itemId: string;
  providerName: string;
  itemName: string;
  participationType: ParticipationType;
  phase: "pending" | "rejected" | "quoted" | "initiated" | "confirmed";
  order?: Order | null;
  error?: { code: string; message: string };
}

export default function ResultsPanel({
  results,
  selection,
  busy,
  onSelectItem,
  onInit,
  onConfirm,
}: {
  results: SearchResult[];
  selection: Selection | null;
  busy: boolean;
  onSelectItem: (result: SearchResult, item: CatalogItem) => void;
  onInit: () => void;
  onConfirm: () => void;
}) {
  if (results.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {results.map((r) => {
        const isDiscoveryOnly = r.provider.participation_type === "discovery_only";
        return (
          <div
            key={r.bpp_id}
            className={`rounded-xl bg-panel p-3.5 shadow-sm ${
              isDiscoveryOnly ? "border border-dashed border-rust-border" : "border border-border"
            }`}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-text">{r.provider.descriptor.name}</span>
              {isDiscoveryOnly && (
                <span className="rounded border border-rust-border bg-rust-dim px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-rust">
                  discovery only
                </span>
              )}
            </div>
            <div className="space-y-2">
              {r.provider.items.map((item) => {
                const isActive = selection?.bppId === r.bpp_id && selection?.itemId === item.id;
                return (
                  <div key={item.id} className="rounded-lg border border-border-soft bg-bg px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-medium text-text">{item.descriptor.name}</span>
                      {!isActive && (
                        <button
                          disabled={busy}
                          onClick={() => onSelectItem(r, item)}
                          className="shrink-0 rounded border border-border px-2.5 py-1 text-[11px] font-medium text-text-dim transition-colors hover:border-amber-border hover:text-amber disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Select
                        </button>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {Object.entries(item.tags).map(([k, v]) => (
                        <span
                          key={k}
                          className="rounded bg-border-soft px-1.5 py-0.5 text-[10px] text-text-dim"
                        >
                          {k.replace(/_/g, " ")}: {String(v)}
                        </span>
                      ))}
                    </div>

                    {isActive && selection && <SelectionStatus selection={selection} busy={busy} onInit={onInit} onConfirm={onConfirm} />}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SelectionStatus({
  selection,
  busy,
  onInit,
  onConfirm,
}: {
  selection: Selection;
  busy: boolean;
  onInit: () => void;
  onConfirm: () => void;
}) {
  if (selection.phase === "pending") {
    return <p className="mt-2 text-[11px] italic text-text-faint">Waiting for the provider to respond…</p>;
  }
  if (selection.phase === "rejected") {
    return (
      <p className="mt-2 text-[11px] text-rust">
        Declined — {selection.error?.message ?? "not supported"}
      </p>
    );
  }
  if (selection.phase === "quoted") {
    return (
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-amber">Quoted — ready to confirm details.</span>
        <button
          disabled={busy}
          onClick={onInit}
          className="shrink-0 rounded border border-amber-border bg-amber-dim px-2.5 py-1 text-[11px] font-medium text-amber transition-colors hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Confirm details
        </button>
      </div>
    );
  }
  if (selection.phase === "initiated") {
    return (
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-amber">Terms set — ready to finalize.</span>
        <button
          disabled={busy}
          onClick={onConfirm}
          className="shrink-0 rounded border border-green-border bg-green-dim px-2.5 py-1 text-[11px] font-medium text-green transition-colors hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Finalize booking
        </button>
      </div>
    );
  }
  return (
    <p className="mt-2 text-[11px] font-medium text-green">
      Booked — order {selection.order?.id}
    </p>
  );
}
