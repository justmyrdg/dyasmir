import { config } from './config';
import { createApp } from './app';
import { startAutoSubmitJob } from './attempts/auto-submit.job';
import { prisma } from './db';

async function main() {
  await prisma.$connect();
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`JASthinkAboutIT API listening on http://localhost:${config.port} (CORS origin: ${config.frontendUrl})`);
  });
  const job = config.enableAutoSubmitJob ? startAutoSubmitJob() : null;

  const shutdown = async () => {
    job?.stop();
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
