export type ParseErrorCode =
  | "empty"
  | "unrecognised"
  | "bad_checksum"
  | "bad_encoding"
  | "bad_amount"
  | "unsupported";

export interface ParseError {
  code: ParseErrorCode;
  /** What happened and what the user can do next; safe to show as-is. */
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ParseError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (code: ParseErrorCode, message: string): Result<never> => ({
  ok: false,
  error: { code, message },
});
