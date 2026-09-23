import { useRef, useState } from "react";
import { api } from "./api";
import NetworkDiagram, { type DiagramPulse, type NetworkNode, type NodeStatus } from "./components/NetworkDiagram";
import ResultsPanel, { type Selection } from "./components/ResultsPanel";
import RightPanel, { type LogLine, type StepSummary, type TraceEntry } from "./components/RightPanel";
import SearchBar from "./components/SearchBar";
import type { CatalogItem, Domain, SearchResult } from "./types";

const DOMAIN_INFO: Record<Domain, { title: string; blurb: string; queryPlaceholder: string; regionPlaceholder: string }> = {
  "ngo-support": {
    title: "UC1 — NGO Support",
    blurb: "Connect an early-childhood practitioner with support organisations.",
    queryPlaceholder: "ECD materials",
    regionPlaceholder: "Bushbuckridge",
  },
  coaching: {
    title: "UC2 — Coaching",
    blurb: "Match someone looking for a coach with the right person, e.g. Naledi finding the right Thabo.",
    queryPlaceholder: "coaching, Sesotho",
    regionPlaceholder: "Bushbuckridge",
  },
};

let lineId = 0;
let pulseKey = 0;
let traceId = 0;

export default function App() {
  const [domain, setDomain] = useState<Domain | null>(null);
  const [txId, setTxId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<NetworkNode[]>([]);
  const [statusByNode, setStatusByNode] = useState<Record<string, NodeStatus>>({});
  const [pulse, setPulse] = useState<DiagramPulse | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [summary, setSummary] = useState<StepSummary | null>(null);
  const [currentResponse, setCurrentResponse] = useState<unknown>(undefined);
  const [rawLog, setRawLog] = useState<TraceEntry[]>([]);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  const seenBpp = useRef<Set<string>>(new Set());

  const pushLine = (text: string, tone: LogLine["tone"] = "info") =>
    setLines((prev) => [...prev, { id: lineId++, text, tone }]);

  const refreshLog = async (tx: string) => {
    try {
      const log = await api.getLog(tx);
      setRawLog(
        log.map((entry) => ({
          id: traceId++,
          label: `${entry.direction} · ${entry.note}`,
          payload: entry.payload,
        })),
      );
    } catch {
      // trace is best-effort
    }
  };

  const fireGatewayPulse = (to: string, tone: DiagramPulse["tone"]) => {
    setPulse({ key: pulseKey++, edge: `gateway-${to}`, tone });
    window.setTimeout(() => setPulse(null), 1100);
  };

  const fireBapPulse = (tone: DiagramPulse["tone"]) => {
    setPulse({ key: pulseKey++, edge: "bap-gateway", tone });
    window.setTimeout(() => setPulse(null), 700);
  };

  async function startScenario(d: Domain) {
    setError(null);
    setBusy(true);
    try {
      const providers = await api.listProviders(d);
      seenBpp.current = new Set();
      setDomain(d);
      setTxId(null);
      setResults([]);
      setSelection(null);
      setFormKey((k) => k + 1);
      setNodes(providers.map((p) => ({ id: p.subscriber_id, name: p.subscriber_id, participation_type: p.participation_type })));
      const initialStatus: Record<string, NodeStatus> = {};
      providers.forEach((p) => (initialStatus[p.subscriber_id] = "idle"));
      setStatusByNode(initialStatus);
      setLines([]);
      setRawLog([]);
      setPulse(null);
      const fullCount = providers.filter((p) => p.participation_type === "full_transaction").length;
      setSummary({
        title: "Network ready",
        tone: "info",
        facts: [
          { label: "Network", value: DOMAIN_INFO[d].title },
          { label: "Providers registered", value: `${providers.length}` },
          { label: "Full-transaction", value: String(fullCount) },
          { label: "Discovery-only", value: String(providers.length - fullCount) },
        ],
      });
      setCurrentResponse(providers);
      pushLine(
        `${providers.length} provider(s) registered on '${DOMAIN_INFO[d].title}' — real, separate HTTP services. Type a search above.`,
        "info",
      );
    } catch (e) {
      setError(`${(e as Error).message} — is real_protocol running? (python -m real_protocol.serve)`);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    if (!domain) return;
    void startScenario(domain);
  }

  async function handleSearch(query: string, region: string) {
    if (!domain) return;
    setBusy(true);
    setError(null);
    setSelection(null);
    seenBpp.current = new Set();
    setResults([]);
    setStatusByNode((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((id) => (next[id] = "idle"));
      return next;
    });
    try {
      fireBapPulse("amber");
      const { transaction_id } = await api.startSearch(domain, query, region);
      setTxId(transaction_id);
      pushLine(
        query || region
          ? `Sent a search for "${query || "anything"}"${region ? ` near ${region}` : ""} — the gateway ACKed and is broadcasting; matching providers will call back asynchronously.`
          : "Sent an open search (browsing everything) — the gateway ACKed and is broadcasting.",
        "info",
      );

      const final = await api.waitForSettledResults(transaction_id, (batch) => {
        batch.forEach((r, i) => {
          if (seenBpp.current.has(r.bpp_id)) return;
          seenBpp.current.add(r.bpp_id);
          window.setTimeout(() => fireGatewayPulse(r.bpp_id, "amber"), i * 60);
          setNodes((prev) =>
            prev.map((n) =>
              n.id === r.bpp_id
                ? { ...n, name: r.provider.descriptor.name, participation_type: r.provider.participation_type }
                : n,
            ),
          );
          setStatusByNode((prev) => ({ ...prev, [r.bpp_id]: "discovered" }));
          pushLine(
            `on_search callback ← ${r.provider.descriptor.name}: ${r.provider.items.length} matching item(s) (${
              r.provider.participation_type === "full_transaction" ? "can book directly" : "discovery only"
            }).`,
            "info",
          );
        });
        setResults([...batch]);
      });

      setResults(final);
      setCurrentResponse(final);
      if (final.length === 0) {
        setSummary({ title: "No providers matched", tone: "info", facts: [] });
        pushLine("No provider had anything matching that search.", "info");
      } else {
        setSummary({
          title: `${final.length} provider(s) responded`,
          tone: "info",
          facts: final.map((r) => ({
            label: r.provider.descriptor.name,
            value: `${r.provider.items.length} item(s)`,
          })),
        });
      }
      await refreshLog(transaction_id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSelectItem(result: SearchResult, item: CatalogItem) {
    if (!txId) return;
    setBusy(true);
    setError(null);
    const base: Selection = {
      bppId: result.bpp_id,
      itemId: item.id,
      providerName: result.provider.descriptor.name,
      itemName: item.descriptor.name,
      participationType: result.provider.participation_type,
      phase: "pending",
    };
    setSelection(base);
    try {
      const ack = await api.select(txId, result.bpp_id, item.id);
      fireGatewayPulse(result.bpp_id, ack.status === "NACK" ? "rust" : "amber");
      if (ack.status === "NACK" && ack.error) {
        setStatusByNode((prev) => ({ ...prev, [result.bpp_id]: "rejected" }));
        setSelection({ ...base, phase: "rejected", error: ack.error });
        setSummary({
          title: `${result.provider.descriptor.name} can't take the booking`,
          tone: "rust",
          facts: [
            { label: "Why", value: ack.error.message },
            { label: "Error code", value: ack.error.code },
          ],
        });
        pushLine(`Tried to book ${item.descriptor.name} with ${result.provider.descriptor.name} — NACK: ${ack.error.message}`, "rust");
      } else {
        pushLine(`${result.provider.descriptor.name} ACKed the select — waiting for its on_select callback...`, "amber");
        const { order } = await api.waitForOrderStatus(txId, "QUOTED");
        setStatusByNode((prev) => ({ ...prev, [result.bpp_id]: "selected" }));
        setSelection({ ...base, phase: "quoted", order });
        setSummary({
          title: `${result.provider.descriptor.name} sent a quote`,
          tone: "amber",
          facts: Object.entries(order?.quote ?? {}).map(([k, v]) => ({ label: k.replace(/_/g, " "), value: String(v) })),
        });
        pushLine(`on_select callback ← ${result.provider.descriptor.name}: order QUOTED.`, "amber");
      }
      await refreshLog(txId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleInit() {
    if (!txId || !selection) return;
    setBusy(true);
    setError(null);
    try {
      const ack = await api.init(txId, selection.bppId);
      fireGatewayPulse(selection.bppId, "amber");
      if (ack.status === "NACK") throw new Error(ack.error?.message ?? "init was NACKed");
      pushLine(`${selection.providerName} ACKed the init — waiting for its on_init callback...`, "amber");
      const { order } = await api.waitForOrderStatus(txId, "INITIATED");
      setSelection({ ...selection, phase: "initiated", order });
      setSummary({
        title: `${selection.providerName} moved the order forward`,
        tone: "amber",
        facts: [{ label: "Status", value: order?.status ?? "INITIATED" }],
      });
      pushLine(`on_init callback ← ${selection.providerName}: order INITIATED.`, "amber");
      await refreshLog(txId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    if (!txId || !selection) return;
    setBusy(true);
    setError(null);
    try {
      const ack = await api.confirm(txId, selection.bppId);
      fireGatewayPulse(selection.bppId, "green");
      if (ack.status === "NACK") throw new Error(ack.error?.message ?? "confirm was NACKed");
      pushLine(`${selection.providerName} ACKed the confirm — waiting for its on_confirm callback...`, "green");
      const { order } = await api.waitForOrderStatus(txId, "CONFIRMED");
      setStatusByNode((prev) => ({ ...prev, [selection.bppId]: "confirmed" }));
      setSelection({ ...selection, phase: "confirmed", order });
      setSummary({
        title: "Booking confirmed",
        tone: "green",
        facts: [
          { label: "Order ID", value: order?.id ?? "" },
          { label: "Status", value: order?.status ?? "" },
          { label: "Provider", value: selection.providerName },
        ],
      });
      pushLine(`on_confirm callback ← ${selection.providerName}: order ${order?.id} is CONFIRMED.`, "green");
      await refreshLog(txId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg font-sans text-text">
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-panel px-5 py-3.5">
        <div className="flex items-center gap-3">
          <span className="blink-dot h-2 w-2 rounded-full bg-green" />
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-text">Beckn Network Explorer</h1>
            <p className="text-[11px] text-text-faint">
              Live over real HTTP — Registry, Gateway, BAP and each provider are separate services
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {(Object.keys(DOMAIN_INFO) as Domain[]).map((d) => (
            <button
              key={d}
              disabled={busy}
              onClick={() => startScenario(d)}
              title={DOMAIN_INFO[d].blurb}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                domain === d
                  ? "border-amber-border bg-amber-dim text-amber"
                  : "border-border text-text-dim hover:border-text-faint hover:text-text"
              }`}
            >
              {DOMAIN_INFO[d].title}
            </button>
          ))}
          <button
            disabled={!domain || busy}
            onClick={reset}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-dim transition-colors hover:border-text-faint hover:text-text disabled:opacity-40"
          >
            Reset
          </button>
        </div>
      </header>

      {error && (
        <div className="shrink-0 border-b border-rust-border bg-rust-dim px-5 py-2 text-xs text-rust">{error}</div>
      )}

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
          {!domain ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
              <p className="text-sm text-text-dim">Pick a scenario above to open a session against the live backend.</p>
              <p className="max-w-sm text-xs text-text-faint">
                Registry, Gateway, BAP and every provider are real, separate HTTP services — type a real search and
                watch the actual matching providers answer.
              </p>
            </div>
          ) : (
            <>
              <NetworkDiagram nodes={nodes} bapId="nfh-bap" statusByNode={statusByNode} pulse={pulse} />

              <SearchBar
                key={formKey}
                queryPlaceholder={DOMAIN_INFO[domain].queryPlaceholder}
                regionPlaceholder={DOMAIN_INFO[domain].regionPlaceholder}
                disabled={busy}
                onSearch={handleSearch}
              />

              <ResultsPanel
                results={results}
                selection={selection}
                busy={busy}
                onSelectItem={handleSelectItem}
                onInit={handleInit}
                onConfirm={handleConfirm}
              />

              <div className="flex flex-wrap gap-x-5 gap-y-2 text-[11px] text-text-dim">
                <Legend swatch="border-solid border-text-faint" label="full-transaction provider" />
                <Legend swatch="border-dashed border-rust-border" label="discovery-only provider" />
                <Legend dot="bg-amber" label="in progress / quoted" />
                <Legend dot="bg-green" label="confirmed" />
              </div>
            </>
          )}
        </main>

        <aside className="w-[420px] shrink-0">
          <RightPanel steps={lines} summary={summary} currentResponse={currentResponse} rawLog={rawLog} />
        </aside>
      </div>
    </div>
  );
}

function Legend({ swatch, dot, label }: { swatch?: string; dot?: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      {swatch && <span className={`h-2.5 w-2.5 rounded-sm border ${swatch}`} />}
      {dot && <span className={`h-2 w-2 rounded-full ${dot}`} />}
      <span>{label}</span>
    </div>
  );
}
