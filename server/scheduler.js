import { Cron } from 'croner';
import { TZ, log } from './config.js';
import { refresh } from './builder.js';

let job = null;

export function validateCron(expr) {
  try {
    new Cron(expr, { paused: true, timezone: TZ }).stop();
    return null;
  } catch (e) {
    return e.message;
  }
}

export function schedule(expr) {
  job?.stop();
  job = null;
  if (!expr) {
    log('Scheduled refresh disabled');
    return;
  }
  job = new Cron(expr, { timezone: TZ, protect: true }, () => {
    refresh({ trigger: 'schedule' }).catch((e) => log(`Scheduled refresh failed: ${e.message}`));
  });
  log(`Scheduled refresh "${expr}" (${TZ}), next at ${job.nextRun()?.toISOString()}`);
}

export const nextRun = () => job?.nextRun()?.toISOString() ?? null;
