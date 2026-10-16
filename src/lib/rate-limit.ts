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
  // en la IP de origen de una cap_session.
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
 *
 * Las IPv6 se agrupan en su prefijo /64: ver `ipv6Bucket64`.
 */
function sanitizeIp(ip: string, fallback: string): string {
  const value = ip.trim().slice(0, 45); // 45 = longitud máxima de una IPv6
  const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(value);
  if (isIpv4) return value;
  const isIpv6 = value.includes(':') && /^[0-9a-fA-F:]+$/.test(value);
  if (isIpv6) return ipv6Bucket64(value) ?? fallback;
  // Detrás del proxy de confianza esto ya es una IP real; si llega algo con
  // otra forma (basura o intento de inyección) lo descartamos al fallback en
  // vez de fabricar una clave de Redis rara.
  return fallback;
}

/**
 * Devuelve el prefijo /64 de una IPv6 (los 4 primeros hextetos + "::"), o
 * null si la cadena no es una IPv6 válida.
 *
 * ¿Por qué /64? Todos los límites del sistema (rate limit, daily cap,
 * binding de sesiones de captcha) asumen "1 IP ≈ 1 identidad". En IPv6 eso
 * NO se cumple: un solo cliente suele controlar un /64 entero (2^64
 * direcciones, asignación habitual de VPS/ISPs) y las Privacy Extensions
 * (RFC 4941) rotan la mitad baja incluso en usuarios legítimos. Keyear por
 * la dirección completa permite rotar direcciones para resetear cualquier
 * límite por IP, y a la vez es poco fiable para usuarios honestos.
 *
 * Agrupar por /64 replica la semántica del NAT en IPv4: varios dispositivos
 * de una red comparten prefijo, igual que comparten IPv4 pública, así que no
 * introduce falsos positivos nuevos y cierra la rotación gratuita.
 *
 * Caveat: alguien con una delegación mayor (/48, /56) aún dispone de varios
 * /64, pero pasa de 2^64 identidades gratis a un número pequeño y costoso.
 */
function ipv6Bucket64(ip: string): string | null {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  // Sin "::" deben venir los 8 hextetos; con "::" este representa al menos uno.
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  if (halves.length === 2 && missing === 0) return null;
  const hextets =
    halves.length === 2 ? [...head, ...Array<string>(missing).fill('0'), ...tail] : head;
  if (hextets.length !== 8) return null;
  if (!hextets.every((h) => /^[0-9a-fA-F]{1,4}$/.test(h))) return null;
  return `${hextets[0]}:${hextets[1]}:${hextets[2]}:${hextets[3]}::`;
}
