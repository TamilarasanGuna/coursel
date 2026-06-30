import cron from 'node-cron';
import { config } from './config.js';
import { runSync } from './sync.js';

export function startScheduler() {
  if (!cron.validate(config.pollCron)) {
    console.error(`[scheduler] invalid POLL_CRON "${config.pollCron}" — auto-poll disabled`);
    return;
  }
  cron.schedule(config.pollCron, async () => {
    try {
      const r = await runSync({ batch: config.syncBatchSize });
      // Quiet logging (fires often): only log real work or errors.
      if (r && !r.skipped) console.log('[scheduler] auto-poll done:', JSON.stringify(r));
    } catch (e) {
      console.error('[scheduler] auto-poll failed:', e.message);
    }
  });
  console.log(`[scheduler] auto-poll scheduled: "${config.pollCron}" (batch ${config.syncBatchSize || 'all'})`);

  if (config.pollOnStartup) {
    // delay a few seconds so the server is fully up first
    setTimeout(() => {
      console.log('[scheduler] running startup sync...');
      runSync({ batch: config.syncBatchSize }).then(
        (r) => console.log('[scheduler] startup sync done:', JSON.stringify(r)),
        (e) => console.error('[scheduler] startup sync failed:', e.message)
      );
    }, 4000);
  }
}
