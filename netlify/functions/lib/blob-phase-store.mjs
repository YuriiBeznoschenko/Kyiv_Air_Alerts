import { getDeployStore, getStore } from '@netlify/blobs';

const STORE_NAME = 'kyiv-alert-phase-history';
const STATE_KEY = 'collector-state-v1';

export function createPhaseStateStore(_env = process.env, options = {}) {
  const blobStore = options.deployScoped
    ? getDeployStore(STORE_NAME)
    : getStore({ name: STORE_NAME, consistency: 'strong' });
  return createBlobStoreAdapter(blobStore);
}

export function createBlobStoreAdapter(blobStore) {
  return {
    async read() {
      const entry = await blobStore.getWithMetadata(STATE_KEY, {
        consistency: 'strong',
        type: 'json',
      });
      return entry ? { data: entry.data, etag: entry.etag } : { data: null, etag: null };
    },

    async update(mutator, attempts = 4) {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const current = await this.read();
        const next = await mutator(current.data);
        const options = current.etag
          ? { onlyIfMatch: current.etag }
          : { onlyIfNew: true };
        const result = await blobStore.setJSON(STATE_KEY, next, options);
        if (result?.modified) return next;
      }
      throw new Error('Phase history write conflict; retry on the next collection cycle');
    },
  };
}
