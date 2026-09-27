import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { createWorld, identifierSchema, MAX_MESSAGE_BYTES, worldSchema } from './model.js';
import { MemoryPersistence } from './persistence.js';
import type { WorldPersistence } from './persistence.js';
import { parseModMessage, transactionSchema } from './protocol.js';
import type { Change } from './protocol.js';
import type { ErrorCode } from './protocol.js';
import { readFile } from 'node:fs/promises';
import { entityWriteSchema, ManagementError, WorldManager } from './management.js';

export interface AppOptions {
  worldId?: string;
  persistence?: WorldPersistence;
  replicationToken?: string;
  logger?: boolean;
  handshakeTimeoutMs?: number;
  ackTimeoutMs?: number;
  maxQueuedPatches?: number;
}

function hash(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export async function buildApp(options: AppOptions = {}) {
  const worldId = identifierSchema.parse(options.worldId ?? 'demo');
  if (options.replicationToken !== undefined && options.replicationToken.length < 16) {
    throw new Error('REPLICATION_TOKEN must contain at least 16 characters when configured');
  }
  const persistence = options.persistence ?? new MemoryPersistence();
  const saved = await persistence.load(worldId);
  const world = saved === null ? createWorld(worldId) : worldSchema.parse(saved);
  if (world.worldId !== worldId) throw new Error('Stored world identity does not match configuration');
  world.state.blocks.sort((a, b) =>
    a.position.x - b.position.x || a.position.y - b.position.y || a.position.z - b.position.z);
  world.state.entities.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const snapshot = (sessionId: string) => JSON.stringify({
    protocolVersion: 1, type: 'SNAPSHOT', sessionId, ...world,
  });
  if (Buffer.byteLength(snapshot(randomUUID()), 'utf8') > MAX_MESSAGE_BYTES) {
    throw new Error('Initial snapshot exceeds protocol message limit');
  }
  // Complete initialization before accepting a connection. Bad stored data fails startup.
  if (saved === null) await persistence.save(world);

  const app = Fastify({
    logger: options.logger ? { redact: ['req.headers.authorization'] } : false,
    bodyLimit: MAX_MESSAGE_BYTES,
  });
  await app.register(websocket, {
    options: { maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false },
  });
  const sessions = new Map<string, boolean>();
  const subscribers = new Set<(change: Change) => void>();
  const manager = new WorldManager(world, persistence, change => {
    for (const publish of subscribers) publish(change);
  });
  const managementToken = randomUUID();
  const assets = new URL('../../public/', import.meta.url);
  const health = () => ({
    status: 'ok',
    stage: 'replication',
    protocolVersion: 1,
    runtime: 'single-player-integrated-only',
    persistence: persistence.durable ? 'durable' : 'memory',
    worldId, epoch: manager.snapshot().epoch, revision: manager.snapshot().revision,
    connectedViewers: sessions.size,
    synchronizedViewers: [...sessions.values()].filter(Boolean).length,
  });
  app.get('/health', async (_request, reply) => reply.header('Cache-Control', 'no-store').send(health()));
  for (const [route, file, type] of [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/dashboard.css', 'dashboard.css', 'text/css; charset=utf-8'],
    ['/dashboard.js', 'dashboard.js', 'text/javascript; charset=utf-8'],
  ] as const) {
    const content = await readFile(new URL(file, assets), 'utf8');
    app.get(route, async (_request, reply) => reply.type(type)
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
      .send(content));
  }

  await app.register(async management => {
    management.addHook('onRequest', async (request, reply) => {
      const host = request.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host) ||
          (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`) ||
          request.headers['sec-fetch-site'] === 'cross-site' || request.headers.authorization !== undefined) {
        return reply.code(403).send({ code: 'FORBIDDEN', message: 'Use the local dashboard to manage this world.' });
      }
      if (request.method !== 'GET' && !timingSafeEqual(
        hash(String(request.headers['x-xinecraft-management'] ?? '')), hash(managementToken),
      )) {
        return reply.code(403).send({ code: 'FORBIDDEN', message: 'Reload the dashboard before making changes.' });
      }
    });
    management.addHook('onSend', async (_request, reply, payload) => {
      reply.header('Cache-Control', 'no-store');
      return payload;
    });
    management.get('/api/world', async () => ({
      world: manager.snapshot(), managementToken, durable: persistence.durable,
    }));
    management.post('/api/transactions', async (request, reply) => {
      const parsed = transactionSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ code: 'INVALID_TRANSACTION', message: 'Invalid above-ground transaction.' });
      try { return await manager.transact(parsed.data); }
      catch (error) {
        if (error instanceof ManagementError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
        return reply.code(503).send({ code: 'SAVE_FAILED', message: 'The transaction was not saved.' });
      }
    });
    for (const create of [true, false]) {
      management.route<{ Params: { id: string } }>({
        method: create ? 'POST' : 'PUT',
        url: create ? '/api/entities' : '/api/entities/:id',
        handler: async (request, reply) => {
          const parsed = entityWriteSchema.safeParse(request.body);
          if (!parsed.success) {
            return reply.code(400).send({ code: 'INVALID_ENTITY', message: 'Check position and rotation values. Entity identity and type cannot be changed.',
              issues: parsed.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })),
            });
          }
          try {
            const result = await manager.writeEntity(parsed.data, create ? undefined : request.params.id);
            return reply.code(create ? 201 : 200).send(result);
          } catch (error) {
            if (error instanceof ManagementError) {
              return reply.code(error.statusCode).send({ code: error.code, message: error.message });
            }
            request.log.error('Could not save the authoritative entity transaction');
            return reply.code(503).send({ code: 'SAVE_FAILED', message: 'The server could not save this change. Your draft has been kept; try again.' });
          }
        },
      });
    }
  });

  app.get('/replication/v1', {
    websocket: true,
    preValidation: async (request, reply) => {
      // A native mod has no browser Origin. Browser pages must not read the world stream.
      if (request.headers.origin !== undefined) {
        return reply.code(403).send({ code: 'UNAUTHORIZED' });
      }
      if (options.replicationToken !== undefined && !timingSafeEqual(
        hash(request.headers.authorization ?? ''), hash(`Bearer ${options.replicationToken}`),
      )) {
        return reply.code(401).send({ code: 'UNAUTHORIZED' });
      }
    },
  }, (socket, request) => {
    const sessionId = randomUUID();
    const connectionWorld = manager.snapshot();
    let phase: 'hello' | 'snapshot' | 'ready' | 'closed' = 'hello';
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let lastPong = Date.now();
    let pendingRevision: number | undefined;
    let acknowledgedRevision = -1;
    const queue: string[] = [];
    let queueBytes = 0;
    const resync = () => {
      phase = 'closed';
      clearTimeout(deadline);
      sessions.delete(sessionId);
      socket.close(1012, 'Reconnect for snapshot');
    };
    const armDeadline = (ms: number) => {
      clearTimeout(deadline);
      deadline = setTimeout(() => socket.terminate(), ms);
      deadline.unref();
    };
    const flush = () => {
      if (phase === 'closed' || phase === 'hello' || pendingRevision !== undefined) return;
      const next = queue.shift();
      if (next) {
        queueBytes -= Buffer.byteLength(next);
        pendingRevision = (JSON.parse(next) as Change).revision;
        sessions.set(sessionId, false);
        socket.send(next);
        armDeadline(options.ackTimeoutMs ?? 30_000);
      } else sessions.set(sessionId, acknowledgedRevision === manager.snapshot().revision);
    };
    const publish = (change: Change) => {
      if (phase === 'closed') return;
      const message = JSON.stringify({ protocolVersion: 1, type: 'PATCH', sessionId, worldId, ...change });
      queue.push(message);
      queueBytes += Buffer.byteLength(message);
      sessions.set(sessionId, false);
      if (queue.length > (options.maxQueuedPatches ?? 128) || queueBytes > 8 * 1024 * 1024) resync();
      else flush();
    };
    subscribers.add(publish);
    const fail = (code: ErrorCode) => {
      if (phase === 'closed') return;
      phase = 'closed';
      clearTimeout(deadline);
      sessions.delete(sessionId);
      socket.send(JSON.stringify({ protocolVersion: 1, type: 'ERROR', code }));
      socket.close(1008, code);
    };
    armDeadline(options.handshakeTimeoutMs ?? 10_000);
    const heartbeat = setInterval(() => {
      if (Date.now() - lastPong >= 30_000) socket.terminate();
      else if (socket.readyState === socket.OPEN) socket.ping();
    }, 15_000);
    heartbeat.unref();
    socket.on('pong', () => { lastPong = Date.now(); });
    socket.on('close', () => {
      subscribers.delete(publish);
      phase = 'closed';
      clearTimeout(deadline);
      clearInterval(heartbeat);
      sessions.delete(sessionId);
    });
    socket.on('error', () => {
      // Never log a received payload or arbitrary remote diagnostic.
      request.log.warn({ sessionId }, 'Replication socket failed');
      socket.terminate();
    });
    socket.on('message', (data, isBinary) => {
      if (phase === 'closed') return;
      if (isBinary) return fail('INVALID_MESSAGE');
      const parsed = parseModMessage(data.toString());
      if (!parsed.ok) return fail(parsed.code);
      const message = parsed.message;
      if (message.type === 'ERROR') {
        request.log.info({ sessionId, code: message.code }, 'Viewer reported protocol error');
        phase = 'closed';
        sessions.delete(sessionId);
        socket.close(1008, message.code);
        return;
      }
      if (phase === 'hello') {
        if (message.type !== 'HELLO') return fail('INVALID_MESSAGE');
        if (message.worldId !== worldId) return fail('WORLD_NOT_FOUND');
        phase = 'snapshot';
        sessions.set(sessionId, false);
        socket.send(JSON.stringify({
          protocolVersion: 1, type: 'WELCOME', worldId, sessionId, epoch: connectionWorld.epoch,
        }));
        socket.send(JSON.stringify({ protocolVersion: 1, type: 'SNAPSHOT', sessionId, ...connectionWorld }));
        pendingRevision = connectionWorld.revision;
        armDeadline(options.ackTimeoutMs ?? 30_000);
        return;
      }
      if (message.type === 'RESYNC_REQUEST') {
        if (message.sessionId !== sessionId) return fail('INVALID_MESSAGE');
        resync();
        return;
      }
      if (message.type !== 'ACK' || message.sessionId !== sessionId ||
          message.epoch !== connectionWorld.epoch) {
        return fail('INVALID_MESSAGE');
      }
      if (message.revision === acknowledgedRevision) return;
      if (message.revision !== pendingRevision) return fail('INVALID_MESSAGE');
      acknowledgedRevision = message.revision;
      pendingRevision = undefined;
      phase = 'ready';
      clearTimeout(deadline);
      flush();
    });
  });
  await app.ready();
  return app;
}
