import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestStore {
  requestId: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestStore>();

/** Per-request store (request id, authenticated user) available anywhere in the request's async chain. */
export const RequestContext = {
  run<T>(store: RequestStore, fn: () => T): T {
    return storage.run({ ...store }, fn);
  },
  get(): RequestStore | undefined {
    return storage.getStore();
  },
  set(patch: Partial<RequestStore>): void {
    const store = storage.getStore();
    if (store) Object.assign(store, patch);
  },
};
