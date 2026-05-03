export type SearchErrorClass =
  | "transient"
  | "rate_limit"
  | "server"
  | "network"
  | "permanent"
  | "unknown";

export interface InstanceRuntimeState {
  url: string;
  consecutiveFailures: Partial<Record<SearchErrorClass, number>>;
  lastErrorClass?: SearchErrorClass;
  lastStatusCode?: number;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  observedLatencyMs?: number;
  totalRequests: number;
  totalFailures: number;
  permanentSkip?: boolean;
}

export type RuntimeStateStore = Record<string, InstanceRuntimeState>;

interface FailureRecord {
  errorClass: SearchErrorClass;
  statusCode?: number;
  now: number;
}

interface SuccessRecord {
  latencyMs: number;
  now: number;
}

interface AxiosLikeError {
  code?: string;
  response?: {
    status?: number;
    headers?: Record<string, string | string[] | undefined>;
  };
}

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNABORTED",
]);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const BACKOFF: Record<SearchErrorClass, { baseMs: number; multiplier: number; capMs: number }> = {
  transient: { baseMs: 5 * SECOND, multiplier: 1, capMs: MINUTE },
  network: { baseMs: 10 * SECOND, multiplier: 1, capMs: 5 * MINUTE },
  server: { baseMs: 30 * SECOND, multiplier: 1.5, capMs: 30 * MINUTE },
  rate_limit: { baseMs: MINUTE, multiplier: 2, capMs: 24 * HOUR },
  permanent: { baseMs: Number.POSITIVE_INFINITY, multiplier: 1, capMs: Number.POSITIVE_INFINITY },
  unknown: { baseMs: 30 * SECOND, multiplier: 1.5, capMs: 30 * MINUTE },
};

export function createRuntimeState(url: string): InstanceRuntimeState {
  return {
    url,
    consecutiveFailures: {},
    totalRequests: 0,
    totalFailures: 0,
  };
}

export function classifySearchError(error: unknown): SearchErrorClass {
  if (!isObject(error)) return "unknown";

  const err = error as AxiosLikeError;
  const status = err.response?.status;
  if (status === 429) return "rate_limit";
  if (status === 302) {
    const location = headerValue(err.response?.headers, "location");
    if (!location || location === "/" || !location.includes("search")) return "permanent";
    return "unknown";
  }
  if (status === 403) return "unknown";
  if (typeof status === "number" && status >= 500 && status <= 599) return "server";
  if (typeof status === "number" && status >= 400 && status <= 499) return "unknown";
  if (err.code && NETWORK_CODES.has(err.code)) return "network";
  if (err.code === "ESEARXNG_INVALID_RESPONSE") return "transient";

  return "unknown";
}

/** Validates that a value looks like a SearXNG JSON search response. */
export function isValidSearXNGResponse(value: unknown): boolean {
  if (!isObject(value)) return false;
  const response = value as { query?: unknown; results?: unknown };
  return typeof response.query === "string" && Array.isArray(response.results);
}

export function recordFailure(state: InstanceRuntimeState, failure: FailureRecord): InstanceRuntimeState {
  const currentCount = state.consecutiveFailures[failure.errorClass] ?? 0;
  return {
    ...state,
    consecutiveFailures: {
      ...state.consecutiveFailures,
      [failure.errorClass]: currentCount + 1,
    },
    lastErrorClass: failure.errorClass,
    lastStatusCode: failure.statusCode,
    lastFailureAt: failure.now,
    totalRequests: state.totalRequests + 1,
    totalFailures: state.totalFailures + 1,
    permanentSkip: failure.errorClass === "permanent" ? true : state.permanentSkip,
  };
}

export function recordSuccess(state: InstanceRuntimeState, success: SuccessRecord): InstanceRuntimeState {
  const observedLatencyMs = state.observedLatencyMs === undefined
    ? success.latencyMs
    : 0.3 * success.latencyMs + 0.7 * state.observedLatencyMs;

  return {
    ...state,
    consecutiveFailures: {},
    lastErrorClass: undefined,
    lastStatusCode: undefined,
    lastFailureAt: undefined,
    lastSuccessAt: success.now,
    observedLatencyMs,
    totalRequests: state.totalRequests + 1,
    permanentSkip: false,
  };
}

export function computeSkipMs(errorClass: SearchErrorClass, failures: number): number {
  const rule = BACKOFF[errorClass];
  if (errorClass === "permanent") return Number.POSITIVE_INFINITY;
  const exponent = Math.max(failures - 1, 0);
  return Math.min(rule.baseMs * rule.multiplier ** exponent, rule.capMs);
}

export function computeSkipUntil(state: InstanceRuntimeState, now = Date.now()): number | undefined {
  if (state.permanentSkip) return Number.POSITIVE_INFINITY;
  if (!state.lastErrorClass || state.lastFailureAt === undefined) return undefined;

  const failures = state.consecutiveFailures[state.lastErrorClass] ?? 0;
  if (failures <= 0) return undefined;

  const skipUntil = state.lastFailureAt + computeSkipMs(state.lastErrorClass, failures);
  return skipUntil > now ? skipUntil : undefined;
}

/** Remove state entries for URLs no longer in the current ranked public instance list. */
export function pruneRuntimeState(state: RuntimeStateStore, liveUrls: Set<string>): RuntimeStateStore {
  const pruned: RuntimeStateStore = {};
  for (const [url, value] of Object.entries(state)) {
    if (liveUrls.has(url)) pruned[url] = value;
  }
  return pruned;
}

function headerValue(headers: Record<string, string | string[] | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return Array.isArray(value) ? value[0] : value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
