import type { Order, OrderStore, PayoutRecipient, CorridorId } from "@railkit/core";

// Browser storage can be missing or throw (private mode, cleared data), so every access is guarded
// and the app keeps working in memory when it fails.
function read<T>(key: string, fallback: T, storage: Storage | undefined): T {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown, storage: Storage | undefined): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or privacy mode: keep going with the in-memory copy.
  }
}

const safeLocalStorage = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/** Keeps orders on the device so tracking resumes if the app is closed mid-payment. */
export class LocalOrderStore implements OrderStore {
  private orders: Map<string, Order>;
  constructor(
    private storage: Storage | undefined = safeLocalStorage(),
    private key = "errand.orders.v1",
    private keep = 50,
  ) {
    this.orders = new Map(read<Order[]>(key, [], storage).map((o) => [o.id, o]));
  }
  async get(id: string) {
    return this.orders.get(id);
  }
  async put(order: Order) {
    this.orders.set(order.id, order);
    const all = [...this.orders.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, this.keep);
    this.orders = new Map(all.map((o) => [o.id, o]));
    write(this.key, all, this.storage);
  }
  async list() {
    return [...this.orders.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
}

export interface SavedRecipient {
  corridor: CorridorId;
  recipient: PayoutRecipient;
  lastAmount: string;
  usedAt: number;
}

const recipientKey = (s: SavedRecipient) =>
  `${s.corridor}:${s.recipient.type === "mobile-money" ? s.recipient.phone : s.recipient.accountNumber}`;

/** The people this user sends to, most recent first. Only kept on this device. */
export function recipientBook(storage: Storage | undefined = safeLocalStorage(), key = "errand.recipients.v1", keep = 8) {
  return {
    list: (): SavedRecipient[] => read<SavedRecipient[]>(key, [], storage),
    remember(s: SavedRecipient) {
      const rest = read<SavedRecipient[]>(key, [], storage).filter((x) => recipientKey(x) !== recipientKey(s));
      write(key, [s, ...rest].slice(0, keep), storage);
    },
  };
}

/** The beta session token, kept on this device. */
export const sessionToken = {
  get: (storage: Storage | undefined = safeLocalStorage()): string | null => read<string | null>("errand.session.v1", null, storage),
  set: (token: string, storage: Storage | undefined = safeLocalStorage()) => write("errand.session.v1", token, storage),
  clear: (storage: Storage | undefined = safeLocalStorage()) => {
    try {
      storage?.removeItem("errand.session.v1");
    } catch {
      // Nothing to clear.
    }
  },
};

export interface LocalTopup {
  orderId: string;
  provider: string;
  amount: string;
  currency: string;
  /** NIM the offer said to expect. The provider's final amount can differ. */
  expectedNim: string;
  address: string;
  redirectUrl: string;
  createdAt: number;
  /** Last state seen, so the list shows something before the next check. */
  state: string;
}

/** Top-ups started on this device, newest first. Only ids and amounts: the provider holds the payment details. */
export function topupBook(storage: Storage | undefined = safeLocalStorage(), key = "errand.topups.v1", keep = 20) {
  return {
    list: (): LocalTopup[] => read<LocalTopup[]>(key, [], storage),
    put(t: LocalTopup) {
      const rest = read<LocalTopup[]>(key, [], storage).filter((x) => x.orderId !== t.orderId);
      write(key, [t, ...rest].slice(0, keep), storage);
    },
  };
}

/** A random id for this device, so the provider can tell repeat customers apart without knowing who they are. */
export function deviceId(storage: Storage | undefined = safeLocalStorage(), key = "errand.device.v1"): string {
  const known = read<string | null>(key, null, storage);
  if (known) return known;
  const id = `dev-${crypto.randomUUID()}`;
  write(key, id, storage);
  return id;
}
