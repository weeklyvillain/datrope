import { ApiError } from "@datrope/core";
import { isRouteErrorResponse } from "react-router-dom";

export type ErrorKind = "not-found" | "no-access" | "crash";

/** Which error page fits what a route threw: a 404 or 403 (from the router or the API), or anything else. */
export function errorKind(e: unknown): ErrorKind {
  const status = isRouteErrorResponse(e) || e instanceof ApiError ? e.status : undefined;
  if (status === 404) return "not-found";
  if (status === 403) return "no-access";
  return "crash";
}

/** Whether a failed request means "can't reach the server" (no answer, or a proxy's 5xx) rather than "the server said no". */
export function isUnreachable(e: unknown): boolean {
  return !(e instanceof ApiError) || e.status >= 500;
}
