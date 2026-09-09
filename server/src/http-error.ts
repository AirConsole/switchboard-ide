/**
 * A failure with an HTTP status attached.
 *
 * It lives in a module of its own rather than in `workspace.ts` because
 * `files.ts` throws it too, and `workspace.ts` calls into `files.ts` -- keeping
 * the class beside the workspace would make that pair import each other. It is
 * an HTTP concept in any case, not a workspace one.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Machine-readable tag so the client can offer a specific recovery. */
    readonly code?: string,
    /** Extra fields merged into the error response body. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}
