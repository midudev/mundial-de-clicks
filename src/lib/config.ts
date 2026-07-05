/**
 * Configuración centralizada leída de variables de entorno.
 *
 * En local se toman los valores por defecto (o los de `.env`).
 * En Coolify se inyectan como variables de entorno del servicio,
 * sin tocar el código.
 */

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
  },
  rateLimit: {
    /** Máximo de clicks válidos por ventana y por IP. */
    maxPerWindow: envInt('RATE_LIMIT_MAX', 15),
    /** Duración de la ventana en segundos. */
    windowSeconds: envInt('RATE_LIMIT_WINDOW', 1),
  },
  stream: {
    /** Intervalo en ms entre snapshots enviados por SSE. */
    intervalMs: envInt('STREAM_INTERVAL_MS', 1000),
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
