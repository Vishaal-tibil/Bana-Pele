export type ParticipationType = "discovery_only" | "full_transaction";

/** Only "ngo-support" is wired up on the real_protocol backend so far --
 * "coaching" is kept here so the UI can still show it, disabled, and say why. */
export type Domain = "ngo-support" | "coaching";

export interface Descriptor {
  name: string;
  short_desc?: string | null;
}

export interface RegisteredProvider {
  subscriber_id: string;
  url: string;
  domain: string;
  type: "BPP";
  participation_type: ParticipationType;
}

export interface CatalogItem {
  id: string;
  descriptor: Descriptor;
  tags: Record<string, unknown>;
}

export interface CatalogProvider {
  id: string;
  descriptor: Descriptor;
  participation_type: ParticipationType;
  items: CatalogItem[];
}

/** One entry from GET /client/results/{tx_id} -- one BPP's on_search callback. */
export interface SearchResult {
  bpp_id: string;
  bpp_uri: string;
  provider: CatalogProvider;
}

export interface SearchStartResponse {
  transaction_id: string;
  ack: unknown;
}

export interface ActionAckResponse {
  status: "ACK" | "NACK";
  error?: { code: string; message: string };
}

export interface OrderItemRef {
  id: string;
  quantity?: unknown;
}

export interface Order {
  id: string | null;
  provider: { id: string };
  items: OrderItemRef[];
  quote?: Record<string, unknown> | null;
  status: "QUOTED" | "INITIATED" | "CONFIRMED" | null;
}

export interface OrderResponse {
  order: Order | null;
}

/** One entry from GET /client/log/{tx_id}. */
export interface RawLogEntry {
  direction: "sent" | "received";
  note: string;
  payload: Record<string, unknown>;
}

/** A single edge-pulse to animate on the diagram. */
export interface FlowPulse {
  key: number;
  from: "bap" | "gateway" | string;
  to: "bap" | "gateway" | string;
  tone: "amber" | "green" | "rust";
}
