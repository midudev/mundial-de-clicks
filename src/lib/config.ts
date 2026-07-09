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
  security: {
    /**
     * Si se define, toda petición pública salvo health debe traer este valor en
     * `x-origin-guard`. Úsalo con una Transform Rule de Cloudflare para que el
     * origen directo no pueda suplantar cabeceras CF.
     */
    originGuardSecret: env('ORIGIN_GUARD_SECRET', ''),
    /** Secreto HMAC para firmar la cookie persistente de votante. */
    voterIdSecret: env('VOTER_ID_SECRET', ''),
  },
  rateLimit: {
    /**
     * Máximo de clicks válidos por ventana y por IP. Con el default de 5 en
     * una ventana de 1s → 5 clicks/s por IP: cómodo para un humano sin que se
     * note demasiado el freno. NO es la defensa anti-botnet (de eso se encarga el captcha
     * de un solo uso, que limita cuántas identidades existen); esto solo acota
     * el ritmo POR IP.
     */
    maxPerWindow: envInt('RATE_LIMIT_MAX', 5),
    /**
     * Duración de la ventana en segundos. 1s hace el limitado más suave (menos
     * a ráfagas) que ventanas más largas para el mismo ritmo por segundo.
     */
    windowSeconds: envInt('RATE_LIMIT_WINDOW', 1),
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
     * otro reto. Cuanto más bajo, más caro le sale a una botnet cada voto (más
     * PoW por voto) y menos vale una cookie robada. Default conservador: 10.
     * `CAP_SESSION_HARD_VOTE_CAP` es el techo absoluto por si se sube por env.
     */
    votesPerSession: envInt('CAP_VOTES_PER_SESSION', 10),
    /** Duración máxima de una sesión de captcha, en segundos. */
    sessionTtlSeconds: envInt('CAP_SESSION_TTL_SECONDS', 120),
    /** Retos Cap máximos por IP y minuto. */
    challengeMaxPerMinute: envInt('CAP_CHALLENGE_MAX_PER_MINUTE', 6),
    /** Canjes Cap máximos por IP y minuto. */
    redeemMaxPerMinute: envInt('CAP_REDEEM_MAX_PER_MINUTE', 12),
    /** Límite duro de votos que puede consumir una sesión Cap. */
    hardVotesPerSession: envInt('CAP_SESSION_HARD_VOTE_CAP', 50),
    /** Dificultad base del PoW de Cap. */
    challengeDifficultyBase: envInt('CAP_CHALLENGE_DIFFICULTY_BASE', 4),
    /** Dificultad máxima del PoW de Cap. */
    challengeDifficultyMax: envInt('CAP_CHALLENGE_DIFFICULTY_MAX', 8),
    /** Cada cuántos votos diarios por IP sube un punto de dificultad. */
    challengeDifficultyStepVotes: envInt('CAP_CHALLENGE_DIFFICULTY_STEP_VOTES', 250),
  },
  dailyLimit: {
    /** Votos máximos contados por IP en un día UTC. */
    maxVotesPerIp: envInt('DAILY_VOTE_MAX_PER_IP', 2000),
  },
  ranking: {
    /** Edad mínima entre lecturas forzadas por `/api/ranking`. */
    minRefreshMs: envInt('RANKING_MIN_REFRESH_MS', 750),
  },
  stream: {
    /** Intervalo en ms entre snapshots enviados por SSE. */
    intervalMs: envInt('STREAM_INTERVAL_MS', 1000),
    /**
     * Tope de conexiones SSE simultáneas (defensa básica contra que te
     * agoten sockets/memoria abriendo miles de streams).
     */
    maxConnections: envInt('MAX_SSE_CONNECTIONS', 20000),
    /** Tope de conexiones SSE por IP. */
    maxConnectionsPerIp: envInt('MAX_SSE_CONNECTIONS_PER_IP', 4),
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
