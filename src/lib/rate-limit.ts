import { config } from './config';

/**
 * Utilidad para extraer la IP real del cliente.
 *
 * El rate limit en sí se aplica de forma atómica dentro del script Lua
 * de `votes.ts` (junto con la escritura del voto), así que aquí solo
 * queda la obtención de la IP respetando el proxy inverso.
 */

/**
 * Extrae la IP del cliente de forma RESISTENTE A SPOOFING.
 *
 * `x-forwarded-for` tiene la forma "cliente, proxy1, proxy2". El cliente
 * puede FALSEAR las primeras entradas (mandando su propia cabecera), así
 * que NO nos fiamos de la primera. La entrada fiable es la que añadió
 * nuestro propio proxy de confianza, contando desde el final:
 *
 *   parts[length - trustedProxyHops]
 *
 * Con 1 proxy (Traefik en Coolify), es la última entrada = la IP real
 * que Traefik observó, que el cliente no puede falsificar.
 */
export function getClientIp(request: Request, fallback = '0.0.0.0'): string {
  const hops = Math.max(1, config.rateLimit.trustedProxyHops);
  const xff = request.headers.get('x-forwarded-for');

  if (xff) {
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      const index = Math.max(0, parts.length - hops);
      return parts[index];
    }
  }

  // Sin XFF (p.ej. en local sin proxy): x-real-ip o el fallback.
  return request.headers.get('x-real-ip')?.trim() || fallback;
}
