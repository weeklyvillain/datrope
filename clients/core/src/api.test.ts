import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ApiError, createApi, unwrap } from "./api";

const BASE = "http://test.local";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("api", () => {
  it("sends the CSRF header on writes when using the cookie", async () => {
    let csrf: string | null = null;
    server.use(http.patch(`${BASE}/api/users/@me`, ({ request }) => {
      csrf = request.headers.get("X-Datrope-CSRF");
      return HttpResponse.json({ id: "1", username: "a", display_name: "A", is_admin: false, disabled: false, created_at: "2026-01-01T00:00:00Z" });
    }));
    const api = createApi({ baseUrl: BASE });
    await unwrap(api.PATCH("/api/users/@me", { body: { display_name: "A" } }));
    expect(csrf).toBe("1");
  });

  it("sends a bearer token when one is configured", async () => {
    let auth: string | null = null;
    server.use(http.get(`${BASE}/api/sessions`, ({ request }) => {
      auth = request.headers.get("Authorization");
      return HttpResponse.json([]);
    }));
    const api = createApi({ baseUrl: BASE, token: () => "tok" });
    await unwrap(api.GET("/api/sessions"));
    expect(auth).toBe("Bearer tok");
  });

  it("turns error bodies into ApiError with the server's code", async () => {
    server.use(http.post(`${BASE}/api/auth/login`, () =>
      HttpResponse.json({ code: "INVALID_CREDENTIALS", message: "wrong username or password" }, { status: 401 })));
    const api = createApi({ baseUrl: BASE });
    const err = await unwrap(api.POST("/api/auth/login", {
      body: { login: "a", password: "b", device_name: "t", client: "web" },
    })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("INVALID_CREDENTIALS");
    expect((err as ApiError).status).toBe(401);
  });
});
