import type {
  ActionAckResponse,
  OrderResponse,
  RawLogEntry,
  RegisteredProvider,
  SearchResult,
  SearchStartResponse,
} from "./types";

/** The BAP service's client-facing API -- the one node in real_protocol/
 * a browser is meant to talk to directly (see real_protocol/bap_service.py). */
const BAP_URL = "http://localhost:9003";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BAP_URL}${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    const err = new Error(body.detail ?? `HTTP ${res.status}`) as Error & {
      status?: number;
      body?: unknown;
    };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.json();
}

export class ApiTimeoutError extends Error {}

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  { intervalMs = 250, timeoutMs = 8000 }: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!predicate(last)) {
    if (Date.now() > deadline) {
      throw new ApiTimeoutError("Timed out waiting for a response from the network.");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

export const api = {
  listProviders: (domain: string) =>
    request<RegisteredProvider[]>(`/client/providers?${new URLSearchParams({ domain })}`),

  startSearch: (domain: string, category: string, region: string) =>
    request<SearchStartResponse>(
      `/client/search?${new URLSearchParams({ domain, category, region })}`,
      { method: "POST" },
    ),

  getResults: (txId: string) => request<SearchResult[]>(`/client/results/${txId}`),

  /** Real Beckn has no "that's everyone" signal -- a provider with nothing
   * relevant just never calls back. So instead of waiting for an exact
   * count, poll until results stop growing for `settleMs` (having waited
   * at least `minWaitMs` first), or give up at `hardTimeoutMs`. Calls
   * `onProgress` every time the result count grows. */
  waitForSettledResults: async (
    txId: string,
    onProgress?: (results: SearchResult[]) => void,
    { minWaitMs = 500, settleMs = 900, hardTimeoutMs = 6000, pollMs = 200 } = {},
  ): Promise<SearchResult[]> => {
    const start = Date.now();
    let last: SearchResult[] = [];
    let lastChangeAt = start;
    for (;;) {
      const results = await api.getResults(txId);
      if (results.length !== last.length) {
        last = results;
        lastChangeAt = Date.now();
        onProgress?.(results);
      }
      const now = Date.now();
      if (now - start >= hardTimeoutMs) return last;
      if (now - start >= minWaitMs && now - lastChangeAt >= settleMs) return last;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  },

  select: (txId: string, bppId: string, itemId: string) =>
    request<ActionAckResponse>(
      `/client/select?${new URLSearchParams({ tx_id: txId, bpp_id: bppId, item_id: itemId })}`,
      { method: "POST" },
    ),

  init: (txId: string, bppId: string) =>
    request<ActionAckResponse>(
      `/client/init?${new URLSearchParams({ tx_id: txId, bpp_id: bppId })}`,
      { method: "POST" },
    ),

  confirm: (txId: string, bppId: string) =>
    request<ActionAckResponse>(
      `/client/confirm?${new URLSearchParams({ tx_id: txId, bpp_id: bppId })}`,
      { method: "POST" },
    ),

  getOrder: (txId: string) => request<OrderResponse>(`/client/order/${txId}`),

  /** Poll for the async on_{select,init,confirm} callback to land and move the order to `status`. */
  waitForOrderStatus: (txId: string, status: string) =>
    pollUntil(
      () => api.getOrder(txId),
      (r) => r.order?.status === status,
      { timeoutMs: 8000 },
    ),

  getLog: (txId: string) => request<RawLogEntry[]>(`/client/log/${txId}`),
};
