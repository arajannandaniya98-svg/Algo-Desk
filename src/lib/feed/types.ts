export type FeedProvider = "dhan" | "angelone" | "delta" | "demo";

/** One subscribable instrument on a broker feed. key = provider:segment:token */
export interface FeedInstrument {
  key: string;
  provider: FeedProvider;
  segment: string;
  token: string;
  symbol: string;
  tradingSymbol?: string;
  exchange?: string;
  lotSize?: number;
}

export interface FeedCredentials {
  provider: "dhan" | "angelone";
  brokerId: number;
  label: string;
  clientId: string;
  accessToken: string;
  apiKey?: string;
  feedToken?: string;
}

export interface LiveTick {
  key: string;
  symbol: string;
  provider: FeedProvider;
  ltp: number;
  open?: number;
  high?: number;
  low?: number;
  prevClose?: number;
  change?: number;
  changePct?: number;
  volume?: number;
  oi?: number;
  prevOi?: number;
  bid?: number;
  ask?: number;
  ltq?: number;
  atp?: number;
  /** exchange timestamp (epoch ms) */
  exchTs: number;
  /** server receive time (epoch ms) */
  recvTs: number;
  /** exchange → server delay when the broker sends a precise timestamp */
  latencyMs: number | null;
  simulated?: boolean;
}

export interface FeedStatus {
  state: "stopped" | "connecting" | "connected" | "reconnecting";
  provider: FeedProvider | null;
  brokerId: number | null;
  brokerLabel: string;
  connectedAt: number | null;
  lastTickAt: number | null;
  ticksPerSec: number;
  totalTicks: number;
  subscriptions: number;
  reconnects: number;
  lastError: string;
  avgLatencyMs: number | null;
  simulated: boolean;
}
