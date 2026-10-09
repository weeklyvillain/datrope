import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./schema";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiOptions {
  /** "" for the same-origin web app, or e.g. "https://chat.example.com". */
  baseUrl: string;
  /** Native clients return their session token; the web app uses the cookie. */
  token?: () => string | undefined;
}

export function createApi(opts: ApiOptions) {
  const client = createClient<paths>({ baseUrl: opts.baseUrl, credentials: "include" });
  const auth: Middleware = {
    onRequest({ request }) {
      const token = opts.token?.();
      if (token) request.headers.set("Authorization", `Bearer ${token}`);
      else if (request.method !== "GET" && request.method !== "HEAD") request.headers.set("X-Datrope-CSRF", "1");
      return request;
    },
  };
  client.use(auth);
  return client;
}

export type Api = ReturnType<typeof createApi>;

/** Resolves to the response data or throws an ApiError. */
export async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await p;
  if (!response.ok) {
    const e = (error ?? {}) as { code?: string; message?: string; details?: Record<string, unknown> };
    throw new ApiError(response.status, e.code ?? "UNKNOWN", e.message ?? response.statusText, e.details);
  }
  return data as T;
}
