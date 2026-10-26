import { fail, ok, type Result } from "./result";

export interface LightningAddress {
  kind: "lightning-address";
  user: string;
  domain: string;
  /** The LNURL-pay endpoint to fetch (LUD-16). */
  url: string;
}

const ADDRESS = /^([a-z0-9._+-]+)@((?:[a-z0-9-]+\.)+[a-z]{2,})$/;

export function parseLightningAddress(input: string): Result<LightningAddress> {
  const s = input.trim().toLowerCase().replace(/^lightning:/, "");
  const m = ADDRESS.exec(s);
  if (!m) return fail("unrecognised", "That isn't a valid Lightning address. It should look like name@domain.com.");
  const [, user, domain] = m;
  return ok({
    kind: "lightning-address",
    user: user!,
    domain: domain!,
    url: `https://${domain}/.well-known/lnurlp/${encodeURIComponent(user!)}`,
  });
}
