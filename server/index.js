import { PORT, TZ, VERSION, log } from './config.js';
import * as store from './db.js';
import { app } from './app.js';
import { ensureMapping } from './mapping.js';
import { schedule } from './scheduler.js';

app.listen(PORT, () => log(`Courarr ${VERSION} listening on :${PORT} (TZ ${TZ})`));
schedule(store.getSettings().schedule);

// Warm the mapping cache in the background so the first anime refresh is quick.
ensureMapping().catch((e) => log(`Initial mapping load failed: ${e.message}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`${sig} received, shutting down`);
    process.exit(0);
  });
}
