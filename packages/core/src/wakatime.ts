import { HttpError, request, wait, type HttpOptions } from "./http.ts";

export const WAKATIME_RANGES = ["last_7_days", "last_30_days", "last_6_months", "last_year", "all_time"] as const;
export type WakaTimeRange = (typeof WAKATIME_RANGES)[number];

export interface WakaTimeLanguage {
  name: string;
  /** Share of coding time, 0–100. */
  percent: number;
  /** Time as WakaTime writes it, for example "3 hrs 12 mins". */
  text: string;
}

export interface WakaTimeStats {
  range: WakaTimeRange;
  /** Total time as WakaTime writes it. */
  total: string;
  /** False while WakaTime is still calculating. */
  ready: boolean;
  languages: WakaTimeLanguage[];
}

export interface WakaTimeOptions extends HttpOptions {
  apiKey: string;
  /** API base. Defaults to WakaTime's; set it for Wakapi or another compatible server. */
  apiUrl?: string;
  range?: WakaTimeRange;
  /** Overall polling budget, including HTTP retries and response bodies; capped at 90 seconds. */
  timeoutMs?: number;
}

const POLL_DELAYS = [10_000, 20_000, 30_000] as const;
const MAX_WAIT_MS = 90_000;

class WakaTimeResponseError extends Error {}

function invalidResponse(): never {
  throw new WakaTimeResponseError("WakaTime returned invalid statistics data.");
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The same signal bounds network work and JSON parsing, including injected clients. */
async function withinBudget<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then((value) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

/** Pending flags take priority over otherwise valid (but potentially stale) values. */
function statistics(body: unknown, range: WakaTimeRange): WakaTimeStats | undefined {
  if (!record(body) || !record(body.data)) return invalidResponse();
  const data = body.data;
  if (data.status !== undefined && !text(data.status)) return invalidResponse();
  if (data.is_up_to_date !== undefined && typeof data.is_up_to_date !== "boolean") return invalidResponse();
  if (data.is_up_to_date === false || (data.status !== undefined && data.status !== "ok")) return undefined;
  if (!text(data.human_readable_total) || !Array.isArray(data.languages)) return invalidResponse();
  const languages = data.languages.map((language: unknown): WakaTimeLanguage => {
    if (!record(language) || !text(language.name) || !text(language.text)
      || typeof language.percent !== "number" || !Number.isFinite(language.percent)
      || language.percent < 0 || language.percent > 100) return invalidResponse();
    return { name: language.name, percent: language.percent, text: language.text };
  });
  return { range, total: data.human_readable_total, ready: true, languages };
}

/**
 * The user's coding time by language. Only languages are kept; WakaTime also
 * returns project names, which may be private, and those are dropped here.
 * Returns ready data only. Pending statistics are polled within one bounded budget.
 */
export async function fetchWakaTime(options: WakaTimeOptions): Promise<WakaTimeStats> {
  const base = (options.apiUrl ?? "https://wakatime.com/api/v1").replace(/\/+$/, "");
  const range = options.range ?? "last_7_days";
  if (!WAKATIME_RANGES.includes(range)) throw new Error("WakaTime requires a supported statistics range.");
  if (!text(options.apiKey) || /[\u0000-\u001f\u007f]/.test(options.apiKey)) throw new Error("WakaTime requires a non-empty single-line credential.");
  const timeoutMs = options.timeoutMs ?? MAX_WAIT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("WakaTime requires a positive integer request timeout.");
  const signal = AbortSignal.timeout(Math.min(timeoutMs, MAX_WAIT_MS));
  try {
    for (let attempt = 0; attempt <= POLL_DELAYS.length; attempt++) {
      const response = await withinBudget(() => request(
        `${base}/users/current/stats/${range}`,
        { headers: { authorization: `Basic ${btoa(options.apiKey)}`, "user-agent": "git-info-combine" }, signal },
        options,
      ), signal);
      if (response.status !== 200 && response.status !== 202) throw new HttpError(response.status, "Unexpected WakaTime HTTP status.");
      if (response.status === 202) {
        // The server can return an empty or incomplete payload while starting its calculation.
        await withinBudget(() => response.body?.cancel() ?? Promise.resolve(), signal);
      } else {
        let body: unknown;
        try { body = await withinBudget(() => response.json(), signal); } catch { invalidResponse(); }
        const ready = statistics(body, range);
        if (ready) return ready;
      }
      const delay = POLL_DELAYS[attempt];
      if (delay !== undefined) await wait(delay, signal, options.sleep);
    }
    throw new WakaTimeResponseError(`WakaTime statistics for ${range} are still calculating after 4 attempts. Try again later.`);
  } catch (error) {
    if (signal.aborted) throw new Error("WakaTime statistics request timed out before ready data was available. Try again later.");
    if (error instanceof WakaTimeResponseError) throw error;
    if (error instanceof HttpError) throw new HttpError(error.status, `WakaTime statistics request failed with HTTP ${error.status}.`);
    throw new Error("WakaTime statistics request failed. Check connectivity and API access.");
  }
}
