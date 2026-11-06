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
