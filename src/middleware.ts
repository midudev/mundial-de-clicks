import { defineMiddleware } from 'astro:middleware';

/**
 * Red de seguridad a nivel de proceso + de petición.
 *
 * Objetivo: que el servidor NO se caiga por más que le lancen cosas.
 *   1. Guardas de proceso: un `unhandledRejection`/`uncaughtException`
 *      hace `exit` en Node por defecto. Los capturamos y solo logueamos,
 *      así un error suelto en cualquier rincón no tumba a todos.
 *   2. Guard global de tamaño: cortamos en seco cualquier petición con un
 *      `Content-Length` desproporcionado antes de que llegue a la ruta.
 */

// Tope generoso a nivel global (las rutas sensibles aplican el suyo, más
// estricto). Aquí solo frenamos lo evidentemente abusivo.
const MAX_GLOBAL_BODY_BYTES = 16 * 1024;

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

  if (request.method === 'POST' || request.method === 'PUT') {
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_GLOBAL_BODY_BYTES) {
      return new Response('Payload too large', { status: 413 });
    }
  }

  return next();
});
