import { defineMiddleware } from 'astro:middleware';
import { timingSafeEqual } from 'node:crypto';
import { config } from './lib/config';

/**
 * Red de seguridad a nivel de proceso + de petición.
 *
 * Objetivo: que el servidor NO se caiga por más que le lancen cosas.
 *   1. Guardas de proceso: un `unhandledRejection`/`uncaughtException`
 *      hace `exit` en Node por defecto. Los capturamos y solo logueamos,
 *      así un error suelto en cualquier rincón no tumba a todos.
 *   2. Origin guard: en producción TODA petición sensible debe demostrar que
 *      entró por Cloudflare (header `x-origin-guard` inyectado por una
 *      Transform Rule). Es lo que hace fiable a `cf-connecting-ip`: sin esta
 *      prueba, un atacante que alcance el origen directo podría falsear esa
 *      cabecera y saltarse rate limit, cap diario y la IP de la cap_session.
 *   3. Guard global de tamaño: cortamos en seco cualquier petición con un
 *      `Content-Length` desproporcionado antes de que llegue a la ruta.
 */

// Tope generoso a nivel global (las rutas sensibles aplican el suyo, más
// estricto). Aquí solo frenamos lo evidentemente abusivo.
const MAX_GLOBAL_BODY_BYTES = 16 * 1024;

/**
 * Rutas cuya integridad depende de una IP de cliente fiable (rate limit,
 * cap diario, IP de la sesión de captcha). En producción SOLO pueden servirse
 * si el origin guard está configurado y validado; si no, `cf-connecting-ip`
 * sería spoofeable y con ella todo el anti-abuso. Las lecturas (ranking, SSE)
 * no dependen de la IP para su integridad, así que no se bloquean.
 */
function isIpSensitivePath(pathname: string): boolean {
  return pathname === '/api/vote' || pathname.startsWith('/api/captcha/');
}

/** Comparación en tiempo constante del secreto del origin guard. */
function originGuardMatches(request: Request, secret: string): boolean {
  const provided = request.headers.get('x-origin-guard') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  // timingSafeEqual exige misma longitud; comparamos contra un buffer del
  // mismo tamaño para no filtrar la longitud del secreto por timing.
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

// Se instala UNA sola vez, al cargar el módulo en el arranque del servidor.
const globalForGuards = globalThis as unknown as {
  __mundialProcessGuards?: boolean;
};

if (!globalForGuards.__mundialProcessGuards) {
  globalForGuards.__mundialProcessGuards = true;

  process.on('unhandledRejection', (reason) => {
    console.error(
      '[process] unhandledRejection:',
      reason instanceof Error ? reason.stack ?? reason.message : reason,
    );
    // No relanzamos: preferimos seguir vivos y servir al resto.
  });

  process.on('uncaughtException', (err) => {
    console.error('[process] uncaughtException:', err.stack ?? err.message);
    // Mantenemos el proceso en pie: el estado real vive en DragonFly y cada
    // petición es independiente, así que un fallo aislado no debe echar a
    // todo el mundo. Coolify reiniciaría igualmente si algo fuese grave.
  });
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { request } = context;
  const { pathname } = new URL(request.url);
  const isProd = process.env.NODE_ENV === 'production';
  const guardSecret = config.security.originGuardSecret;

  if (pathname !== '/api/health') {
    if (guardSecret) {
      // Guard configurado: TODA petición (salvo health) debe traer el secreto.
      // Esto certifica que el tráfico pasó por Cloudflare y hace fiable a
      // `cf-connecting-ip`.
      if (!originGuardMatches(request, guardSecret)) {
        return new Response('Forbidden', { status: 403 });
      }
    } else if (isProd && isIpSensitivePath(pathname)) {
      // Producción SIN guard configurado: no podemos probar que el request
      // entró por Cloudflare, así que `cf-connecting-ip` no es de fiar. En vez
      // de servir el anti-abuso con una IP spoofeable, fallamos CERRADO en las
      // rutas cuya integridad depende de esa IP. Las lecturas siguen sirviendo.
      console.error(
        '[security] ORIGIN_GUARD_SECRET sin configurar en producción: ' +
          `bloqueando ${pathname} (cf-connecting-ip no verificable).`,
      );
      return new Response('Service Unavailable', { status: 503 });
    }
  }

  if (request.method === 'POST' || request.method === 'PUT') {
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_GLOBAL_BODY_BYTES) {
      return new Response('Payload too large', { status: 413 });
    }
  }

  return next();
});
