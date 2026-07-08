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
 * Detrás de Cloudflare la fuente fiable es `cf-connecting-ip`: la pone el
 * edge de Cloudflare con la IP REAL del cliente, ya normalizada y sin
 * saltos que contar. El cliente no la puede falsear MIENTRAS el origen solo
 * acepte tráfico de Cloudflare (si el origen es accesible directamente,
 * cualquiera podría mandar esta cabecera; asegúrate de restringir el acceso
 * a las IPs de Cloudflare en el proxy/WAF).
 *
 * Si no hay Cloudflare delante caemos a `x-forwarded-for`, que tiene la forma
 * "cliente, proxy1, proxy2". El cliente puede FALSEAR las primeras entradas
 * (mandando su propia cabecera), así que NO nos fiamos de la primera. La
 * entrada fiable es la que añadió nuestro propio proxy de confianza, contando
 * desde el final:
 *
 *   parts[length - trustedProxyHops]
 *
 * Con 1 proxy (Traefik en Coolify), es la última entrada = la IP real
 * que Traefik observó, que el cliente no puede falsificar.
 */
export function getClientIp(request: Request, fallback = '0.0.0.0'): string {
  // Cloudflare: IP real del cliente, puesta por el edge. Es la fuente
  // preferente cuando estamos detrás de Cloudflare.
  const cfIp = request.headers.get('cf-connecting-ip')?.trim();
  if (cfIp) {
    return sanitizeIp(cfIp, fallback);
  }

  const hops = Math.max(1, config.rateLimit.trustedProxyHops);
  const xff = request.headers.get('x-forwarded-for');

  if (xff) {
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      const index = Math.max(0, parts.length - hops);
      return sanitizeIp(parts[index], fallback);
    }
  }

  // Sin XFF (p.ej. en local sin proxy): x-real-ip o el fallback.
  return sanitizeIp(request.headers.get('x-real-ip')?.trim() ?? '', fallback);
}

/**
 * Normaliza la IP antes de usarla como parte de una clave de Redis
 * (`rl:{ip}:{window}`).
 *
 * La IP procede de una cabecera controlable por quien esté delante: aunque
 * detrás de nuestro proxy de confianza no es falseable, sí conviene ACOTARLA.
 * Nos quedamos solo con caracteres válidos de IPv4/IPv6 y como mucho 45
 * (longitud máxima de una IPv6). Así un `x-forwarded-for` gigante o con basura
 * no puede generar claves enormes ni disparar el uso de memoria de DragonFly.
 */
function sanitizeIp(ip: string, fallback: string): string {
  const value = ip.trim().slice(0, 45); // 45 = longitud máxima de una IPv6
  const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(value);
  const isIpv6 = value.includes(':') && /^[0-9a-fA-F:]+$/.test(value);
  // Detrás del proxy de confianza esto ya es una IP real; si llega algo con
  // otra forma (basura o intento de inyección) lo descartamos al fallback en
  // vez de fabricar una clave de Redis rara.
  return isIpv4 || isIpv6 ? value : fallback;
}
