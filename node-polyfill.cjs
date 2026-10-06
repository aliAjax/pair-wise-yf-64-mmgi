// Node 20 compatibility shim (preloaded via NODE_OPTIONS=--require).
// undici 8 (pulled in by @builder.io/qwik-city) reads
// `worker_threads.markAsUncloneable`, which exists only on Node >= 22.
// The call only marks an object as non-structured-cloneable; a no-op is
// safe for dev/SSR on Node 20. Remove once the runtime is on Node 22+.
const workerThreads = require('node:worker_threads');
if (typeof workerThreads.markAsUncloneable !== 'function') {
  workerThreads.markAsUncloneable = (value) => value;
}
