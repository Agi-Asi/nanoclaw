/**
 * Response handler registry and legacy shutdown compatibility.
 *
 * Extracted from index.ts so that modules calling `registerResponseHandler()`
 * at import time don't hit a TDZ error on the const-array declaration.
 * index.ts imports src/modules/index.js for its side effects, which triggers
 * module registrations that would otherwise happen before index.ts's own
 * const initializers have run. New host start/shutdown hooks live in
 * host-lifecycle.ts; the legacy shutdown API remains here for compatibility.
 *
 * Keep this file dependency-free (log.js is fine, but nothing from
 * modules/* or index.ts itself). Any file imported here must not in turn
 * import from src/index.ts, or the cycle returns.
 */

export interface ResponsePayload {
  questionId: string;
  value: string;
  userId: string | null;
  channelType: string;
  platformId: string;
  threadId: string | null;
}

export type ResponseHandler = (payload: ResponsePayload) => Promise<boolean>;

const responseHandlers: ResponseHandler[] = [];

export function registerResponseHandler(handler: ResponseHandler): void {
  responseHandlers.push(handler);
}

export function getResponseHandlers(): readonly ResponseHandler[] {
  return responseHandlers;
}

type ShutdownCallback = () => void | Promise<void>;
const shutdownCallbacks: ShutdownCallback[] = [];

/**
 * @deprecated Existing callers retain FIFO ordering. New modules should use
 * `onHostShutdown()` from host-lifecycle.ts.
 */
export function onShutdown(cb: ShutdownCallback): void {
  shutdownCallbacks.push(cb);
}

/** @deprecated Used to inspect callbacks registered through `onShutdown()`. */
export function getShutdownCallbacks(): readonly ShutdownCallback[] {
  return shutdownCallbacks;
}
