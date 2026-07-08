/**
 * Configuración centralizada leída de variables de entorno.
 *
 * En local se toman los valores por defecto (o los de `.env`).
 * En Coolify se inyectan como variables de entorno del servicio,
 * sin tocar el código.
 */

// Vuelca los `.env*` a process.env en local (no-op en producción). Debe ir
// ANTES de cualquier lectura de process.env de este módulo.
import './load-env';

/** Lee una variable de entorno con valor por defecto. */
function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

/** Lee una variable de entorno numérica con valor por defecto. */
function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export const config = {
  redis: {
    /**
     * URL de conexión a DragonFly (compatible con protocolo Redis).
     * Formato: redis://[:password@]host:port
     * En Coolify apuntará al nombre del servicio interno de DragonFly.
     */
    url: env('REDIS_URL', buildRedisUrl()),
    /**
     * Timeout DURO por comando (ms). Si DragonFly no responde a tiempo,
     * fallamos rápido en vez de dejar la petición (o el poller) colgada.
     */
    commandTimeoutMs: envInt('REDIS_COMMAND_TIMEOUT_MS', 2000),
  },
  captchaHttp: {
    /** Timeout (ms) del fetch de servidor a servidor contra el servidor Cap. */
    timeoutMs: envInt('CAP_HTTP_TIMEOUT_MS', 5000),
  },
  rateLimit: {
    /**
     * Máximo de clicks válidos por ventana y por IP. Con el default de 10 en
     * una ventana de 1s → 10 clicks/s por IP: cómodo para un humano sin que se
     * note el freno. NO es la defensa anti-botnet (de eso se encarga el captcha
     * de un solo uso, que limita cuántas identidades existen); esto solo acota
     * el ritmo POR IP.
     */
    maxPerWindow: envInt('RATE_LIMIT_MAX', 10),
    /**
     * Duración de la ventana en segundos. 1s hace el limitado más suave (menos
     * a ráfagas) que ventanas más largas para el mismo ritmo por segundo.
     */
    windowSeconds: envInt('RATE_LIMIT_WINDOW', 1),
    /**
     * Número de proxies de confianza entre el cliente y la app. Se usa
     * para leer la IP REAL de `x-forwarded-for` sin que el cliente la
     * pueda falsear. En Coolify hay 1 (Traefik). Si pones un CDN/WAF
     * delante (p.ej. Cloudflare), serían 2.
     */
    trustedProxyHops: envInt('TRUSTED_PROXY_HOPS', 1),
  },
  captcha: {
    /**
     * URL base del servidor Cap standalone, incluyendo la siteKey:
     * `https://mi-cap.ejemplo.com/{siteKey}`. Si está vacía, el captcha
     * queda desactivado y se vota sin él. Nuestro backend hace de proxy a
     * `${apiUrl}/challenge` y `${apiUrl}/redeem` (mismo origen para el
     * widget, sin CORS ni mixed-content).
     */
    apiUrl: env('CAP_API_URL', '').replace(/\/+$/, ''),
    /**
     * Cuántos votos acepta una sesión de captcha antes de obligar a resolver
     * otro reto. Evita que una cookie verificada sea barra libre durante todo
     * su TTL.
     */
    votesPerSession: envInt('CAP_VOTES_PER_SESSION', 80),
    /** Duración máxima de una sesión de captcha, en segundos. */
    sessionTtlSeconds: envInt('CAP_SESSION_TTL_SECONDS', 120),
  },
  stream: {
    /** Intervalo en ms entre snapshots enviados por SSE. */
    intervalMs: envInt('STREAM_INTERVAL_MS', 1000),
    /**
     * Tope de conexiones SSE simultáneas (defensa básica contra que te
     * agoten sockets/memoria abriendo miles de streams).
     */
    maxConnections: envInt('MAX_SSE_CONNECTIONS', 20000),
  },
} as const;

/**
 * Construye la URL de Redis a partir de variables sueltas
 * (útil en local, donde exponemos host/port/password por separado).
 */
function buildRedisUrl(): string {
  const host = env('DRAGONFLY_HOST', 'localhost');
  const port = env('DRAGONFLY_PORT', '6379');
  const password = process.env.DRAGONFLY_PASSWORD;
  const auth = password ? `:${encodeURIComponent(password)}@` : '';
  return `redis://${auth}${host}:${port}`;
}
