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
