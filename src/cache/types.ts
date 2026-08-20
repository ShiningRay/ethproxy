/** Pluggable cache storage. All values are stored as serialized strings. */
export interface CacheBackend {
  get(key: string): Promise<string | null>;
  /** ttlMs === null means the entry never expires. */
  set(key: string, value: string, ttlMs: number | null): Promise<void>;
  delete(key: string): Promise<void>;
  close(): Promise<void>;
}
