import type { APIRoute } from 'astro';
import { getWorldState } from '../../lib/world-state';
import { config } from '../../lib/config';
import { getClientIp, getCloudflareClientIp } from '../../lib/rate-limit';

export const prerender = false;

const globalForStreamLimits = globalThis as unknown as {
  __mundialStreamConnectionsByIp?: Map<string, number>;
};
const connectionsByIp =
  globalForStreamLimits.__mundialStreamConnectionsByIp ??
  (globalForStreamLimits.__mundialStreamConnectionsByIp = new Map());

/**
 * GET /api/stream  (Server-Sent Events)
 *
 * La conexión se limita a SUSCRIBIRSE al estado del mundo. Un único bucle
 * central (WorldState) serializa el snapshot una sola vez por tick y nos
 * pasa los mismos bytes ya codificados: aquí solo los reenviamos. Así, el
 * coste por espectador es mínimo y no penaliza a DragonFly.
 *
 * Incluye backpressure: si un cliente va muy lento y acumula cola, se le
 * descartan frames en vez de tragar memoria (los votos solo suben, así que
 * el siguiente snapshot que reciba ya trae el estado correcto).
 */
export const GET: APIRoute = ({ request }) => {
  const world = getWorldState();
  const ip =
    process.env.NODE_ENV === 'production'
      ? getCloudflareClientIp(request)
      : getClientIp(request);

  if (!ip) {
    return new Response('Trusted IP required', { status: 403 });
  }

  // Defensa básica: si ya hay demasiadas conexiones abiertas, rechazamos
  // las nuevas en vez de tragar sockets/memoria sin límite.
  if (world.connections >= config.stream.maxConnections) {
    return new Response('Too many connections', {
      status: 503,
      headers: { 'retry-after': '5' },
    });
  }

  if ((connectionsByIp.get(ip) ?? 0) >= config.stream.maxConnectionsPerIp) {
    return new Response('Too many connections', {
      status: 429,
      headers: { 'retry-after': '5' },
    });
  }

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      connectionsByIp.set(ip, (connectionsByIp.get(ip) ?? 0) + 1);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        const count = (connectionsByIp.get(ip) ?? 1) - 1;
        if (count > 0) connectionsByIp.set(ip, count);
        else connectionsByIp.delete(ip);
        try {
          controller.close();
        } catch {
          /* ya cerrado */
        }
      };

      const send = (payload: Uint8Array) => {
        if (closed) return;
        // Cliente lento: su cola crece sin parar → descartamos este frame.
        if (
          typeof controller.desiredSize === 'number' &&
          controller.desiredSize < -20
        ) {
          return;
        }
        try {
          controller.enqueue(payload);
        } catch {
          cleanup();
        }
      };

      unsubscribe = world.subscribe(send);

      // El cliente cerró la pestaña / se cayó la conexión.
      request.signal.addEventListener('abort', cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
};
