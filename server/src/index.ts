import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { createServices } from './app.js';
import { registerRoutes } from './routes.js';

const app = Fastify({ logger: true });
const services = createServices();
registerRoutes(app, services);

// Production: the one Fastify process also serves the built Vite bundle
// (single origin, no CORS). In dev, Vite proxies API paths here instead.
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.resolve(fileURLToPath(import.meta.url), '../../../client/dist');
  await app.register(fastifyStatic, { root: clientDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api')) {
      return reply.sendFile('index.html'); // SPA fallback
    }
    return reply.status(404).send({ error: 'not found' });
  });
}

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: '0.0.0.0' });
