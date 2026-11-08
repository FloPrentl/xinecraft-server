import { buildApp } from './app.js';
import { DEFAULT_INITIAL_WORLD_URL, identifierSchema, loadInitialWorld } from './model.js';
import { MemoryPersistence } from './persistence.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535');
}
const worldId = identifierSchema.parse(process.env.WORLD_ID ?? 'demo');
const initialWorldSource = process.env.INITIAL_WORLD_FILE ?? DEFAULT_INITIAL_WORLD_URL;
const persistence = new MemoryPersistence();
await persistence.save(await loadInitialWorld(worldId, initialWorldSource));

const replicationToken = process.env.REPLICATION_TOKEN;
const app = await buildApp({
  worldId,
  persistence,
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
