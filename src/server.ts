import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { CatalogService } from './services/catalogService.js';
import { GiftListStore } from './services/giftListStore.js';
import { SseHandler } from './transport/sseHandler.js';
import { WsHandler } from './transport/wsHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

/** Mapa de extensiones a Content-Type para servir los archivos estáticos del frontend. */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Lee y envía un archivo estático dentro de la carpeta public/.
 * Valida que la ruta resuelta no escape de PUBLIC_DIR (protección contra path traversal).
 */
async function serveStaticFile(
  res: ServerResponse,
  relativePath: string
): Promise<void> {
  const safePath = path.resolve(PUBLIC_DIR, relativePath);
  if (!safePath.startsWith(PUBLIC_DIR + path.sep) && safePath !== PUBLIC_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Acceso denegado');
    return;
  }

  try {
    const content = await readFile(safePath);
    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Recurso no encontrado');
      return;
    }
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Error interno del servidor');
  }
}

/**
 * Punto de entrada del servidor único: levanta el servidor HTTP para servir
 * el frontend estático, el stream SSE de la pantalla (/events) y el upgrade
 * WebSocket de los participantes (/ws) sobre el mismo puerto.
 */
function main(): void {
  const config = loadConfig();
  const store = new GiftListStore();
  const catalog = new CatalogService(config);
  const sseHandler = new SseHandler(store);
  const wsHandler = new WsHandler(store, catalog, sseHandler);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Método no permitido');
      return;
    }

    // Stream unidireccional Server-Sent Events para la pantalla compartida
    if (pathname === '/events') {
      sseHandler.handleConnection(req, res);
      return;
    }

    // Página principal del participante
    if (pathname === '/' || pathname === '/index.html') {
      void serveStaticFile(res, 'index.html');
      return;
    }

    // Página de pantalla compartida (solo lectura)
    if (pathname === '/pantalla' || pathname === '/screen' || pathname === '/screen.html') {
      void serveStaticFile(res, 'screen.html');
      return;
    }

    // Assets estáticos dentro de public/ (CSS y JS)
    const cleanRelative = pathname.replace(/^\/+/, '');
    if (cleanRelative !== '' && !cleanRelative.includes('..')) {
      void serveStaticFile(res, cleanRelative);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Ruta no encontrada');
  });

  // Intercepta el handshake WebSocket en el mismo puerto HTTP
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/ws') {
      wsHandler.handleUpgrade(req, socket, head);
      return;
    }

    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });

  server.listen(config.port, '127.0.0.1', () => {
    console.log('');
    console.log('==============================================================');
    console.log('  TP4 · Regalo Grupal en Tiempo Real (Node.js + TypeScript)');
    console.log('==============================================================');
    console.log(`  Participante (WS):  http://localhost:${config.port}/`);
    console.log(`  Pantalla (SSE):     http://localhost:${config.port}/pantalla`);
    console.log(`  WebSocket endpoint: ws://localhost:${config.port}/ws`);
    console.log(`  SSE endpoint:       http://localhost:${config.port}/events`);
    console.log('--------------------------------------------------------------');
    console.log(`  Catálogo URL:       ${config.catalogBaseUrl}`);
    console.log(`  Timeout catálogo:   ${config.catalogTimeoutMs} ms`);
    console.log(`  Delay simulado:     ${config.catalogDelayMs} ms`);
    console.log('==============================================================');
    console.log('');
  });

  const shutdown = () => {
    console.log('\n[server] Cerrando servidor...');
    wsHandler.closeAll();
    sseHandler.closeAll();
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
