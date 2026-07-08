/**
 * Utilidad para extraer la IP real del cliente.
 *
 * El rate limit en sí se aplica de forma atómica dentro del script Lua
 * de `votes.ts` (junto con la escritura del voto), así que aquí solo
 * queda la obtención de la IP respetando el proxy inverso.
 */

/**
 * Extrae la IP fiable del cliente.
 *
 * Detrás de Cloudflare la fuente fiable es `cf-connecting-ip`: la pone el
 * edge de Cloudflare con la IP REAL del cliente, ya normalizada y sin
 * saltos que contar. El cliente no la puede falsear MIENTRAS el origen solo
 * acepte tráfico de Cloudflare (si el origen es accesible directamente,
 * cualquiera podría mandar esta cabecera; asegúrate de restringir el acceso
 * a las IPs de Cloudflare en el proxy/WAF).
 */
export function getClientIp(request: Request, fallback = '0.0.0.0'): string {
  const cfIp = getCloudflareClientIp(request);
  if (cfIp) return cfIp;

  // Solo para desarrollo local sin Cloudflare. En producción no usamos XFF:
  // una cabecera enviada por el cliente no puede participar en rate limit ni
  // en fingerprints de captcha.
  if (process.env.NODE_ENV !== 'production') {
    return sanitizeIp(request.headers.get('x-real-ip')?.trim() ?? '', fallback);
  }

  return fallback;
}

/** IP aceptable para defensas de seguridad: CF en prod, fallback local en dev. */
export function getTrustedClientIp(request: Request): string | null {
  const cfIp = getCloudflareClientIp(request);
  if (cfIp) return cfIp;
  if (process.env.NODE_ENV !== 'production') return getClientIp(request);
  return null;
}

/** IP real certificada por Cloudflare, o null si falta/no es válida. */
export function getCloudflareClientIp(request: Request): string | null {
  const cfIp = request.headers.get('cf-connecting-ip')?.trim();
  if (!cfIp) return null;
  const sanitized = sanitizeIp(cfIp, '');
  return sanitized || null;
}

/**
 * Normaliza la IP antes de usarla como parte de una clave de Redis
 * (`rl:{ip}:{window}`).
 *
 * La IP procede de una cabecera HTTP, así que conviene ACOTARLA incluso si
 * solo se acepta tráfico de Cloudflare.
 * Nos quedamos solo con caracteres válidos de IPv4/IPv6 y como mucho 45
 * (longitud máxima de una IPv6). Así una cabecera con basura no puede generar
 * claves enormes ni disparar el uso de memoria de DragonFly.
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
