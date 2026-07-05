import { createClient, type RedisClientType } from 'redis';
import { config } from './config';

/**
 * Cliente singleton hacia DragonFly.
 *
 * DragonFly habla el protocolo de Redis, así que usamos el cliente
 * oficial `redis`. Mantenemos UNA sola conexión reutilizada entre
 * peticiones (en dev, Astro puede recargar el módulo, por eso lo
 * guardamos también en `globalThis` para no abrir conexiones de más).
 */

const globalForRedis = globalThis as unknown as {
  __mundialRedis?: RedisClientType;
  __mundialRedisReady?: Promise<RedisClientType>;
};

function createRedisClient(): RedisClientType {
  const client: RedisClientType = createClient({
    url: config.redis.url,
    socket: {
      // Reconexión con backoff exponencial acotado: si DragonFly se
      // reinicia (o hacemos un snapshot), el cliente vuelve solo.
      reconnectStrategy: (retries) => Math.min(retries * 50, 2000),
    },
  });

  client.on('error', (err) => {
    // No lanzamos: dejamos que la estrategia de reconexión trabaje.
    console.error('[redis] error:', err.message);
  });

  return client;
}

/**
 * Devuelve un cliente conectado y listo para usar.
 * Reutiliza la conexión existente si ya está abierta.
 */
export async function getRedis(): Promise<RedisClientType> {
  if (globalForRedis.__mundialRedis?.isReady) {
    return globalForRedis.__mundialRedis;
  }

  // Evita condiciones de carrera: si varias peticiones piden conexión
  // a la vez, todas esperan a la misma promesa de conexión.
  if (!globalForRedis.__mundialRedisReady) {
    const client = createRedisClient();
    globalForRedis.__mundialRedis = client;
    globalForRedis.__mundialRedisReady = client
      .connect()
      .then(() => client)
      .catch((err) => {
        globalForRedis.__mundialRedisReady = undefined;
        throw err;
      });
  }

  return globalForRedis.__mundialRedisReady;
}

/**
 * Envuelve una promesa con un timeout DURO.
 *
 * node-redis no aborta comandos individuales: si DragonFly se cuelga (una
 * partición de red, un snapshot largo, un `SAVE` bloqueante), el `await`
 * quedaría colgado para siempre. Eso es peligroso: en el endpoint de voto
 * agota conexiones, y en el poller del WorldState deja el guard `polling`
 * atascado y CONGELA el SSE de todos los espectadores. Aquí fallamos rápido
 * y dejamos que la capa superior responda un error controlado y reintente.
 *
 * Nota: el comando subyacente puede completarse en el servidor más tarde;
 * para nuestras operaciones (voto idempotente vía script, lecturas) eso es
 * seguro: el siguiente snapshot reconcilia el estado real.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = 'redis',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}: timeout tras ${ms}ms`)),
      ms,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
