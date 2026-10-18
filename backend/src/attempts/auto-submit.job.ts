import cron from 'node-cron';
import { autoSubmitExpired } from './grading';

/** Every minute: submit and grade attempts whose time ran out, so students who closed the browser are still graded. */
export function startAutoSubmitJob() {
  let running = false;
  const task = cron.schedule('* * * * *', async () => {
    if (running) return;
    running = true;
    try {
      const n = await autoSubmitExpired();
      if (n > 0) console.log(`[auto-submit] submitted ${n} expired attempt(s)`);
    } catch (err) {
      console.error('[auto-submit] run failed', err);
    } finally {
      running = false;
    }
  });
  return task;
}
