import type { Fetch } from "./model.ts";

export interface HttpOptions {
  fetch?: Fetch;
  /** Waits between retries. Replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  retries?: number;
  /** Optional budget for one request, including retries and rate-limit waits. */
  timeoutMs?: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

async function wait(ms: number, signal: AbortSignal | null | undefined, sleep?: HttpOptions["sleep"]): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => { cleanup(); reject(signal!.reason); };
    const done = () => { cleanup(); resolve(); };
    const failed = (error: unknown) => { cleanup(); reject(error); };
    signal?.addEventListener("abort", abort, { once: true });
    if (sleep) Promise.resolve().then(() => sleep(ms)).then(done, failed);
    else timer = setTimeout(done, ms);
  });
}

/**
 * Fetches with retries on rate limits and server errors. Error messages carry
 * the status and the URL path only, never response bodies, which can name
 * private repos.
 */
export async function request(
  url: string,
  init: RequestInit,
  options: HttpOptions = {},
): Promise<Response> {
  const fetchFn = options.fetch ?? fetch;
  const retries = options.retries ?? 3;
  const signal = init.signal ?? (options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs));
  const requestInit = signal ? { ...init, signal } : init;

  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const response = await fetchFn(url, requestInit);
    if (response.ok) return response;

    if (attempt < retries && RETRY_STATUSES.has(response.status)) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000, signal, options.sleep);
      continue;
    }

    throw new HttpError(response.status, `${init.method ?? "GET"} ${new URL(url).pathname} failed with HTTP ${response.status}`);
  }
}
