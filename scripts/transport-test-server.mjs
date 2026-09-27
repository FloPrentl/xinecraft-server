// Isolated harness for the Java receiver regression. Never used by npm start.
import { buildApp } from '../dist/src/app.js';
import http from 'node:http';
const app = await buildApp({ worldId: 'transport-test' });
const port = Number(process.env.PORT ?? 3101);
const control = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/test/disconnect') {
    response.writeHead(404).end(); return;
  }
  for (const socket of app.websocketServer.clients) socket.close(1012, 'Test reconnect');
  response.writeHead(200).end('{}');
});
await app.listen({ host: '127.0.0.1', port });
control.listen(port + 1, '127.0.0.1', () => console.log(`Isolated transport-test server: http://127.0.0.1:${port} (control port ${port + 1})`));
const stop = async () => {
  control.close(); control.closeAllConnections();
  for (const socket of app.websocketServer.clients) socket.terminate();
  await app.close();
};
process.on('SIGINT', stop); process.on('SIGTERM', stop);
