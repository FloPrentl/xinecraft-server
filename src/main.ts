import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535');
}
const replicationToken = process.env.REPLICATION_TOKEN;
const app = await buildApp({
  worldId: process.env.WORLD_ID ?? 'demo',
  logger: true,
  ...(replicationToken === undefined ? {} : { replicationToken }),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().catch(() => { process.exitCode = 1; });
  });
}
try {
  // This foundation deliberately exposes no public-network binding option.
  await app.listen({ host: '127.0.0.1', port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
