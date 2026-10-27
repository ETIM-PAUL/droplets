import { UserFacingError } from "@railkit/core";

/** A provider failure turned into a message for the user and an HTTP status for our API's reply. */
export class ProviderError extends UserFacingError {
  constructor(
    message: string,
    /** HTTP status to hand back to our own client. */
    readonly status: 400 | 404 | 502,
  ) {
    super(message);
  }
}
