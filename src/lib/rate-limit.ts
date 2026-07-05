/**
 * Utilidad para extraer la IP real del cliente.
 *
 * El rate limit en sí se aplica de forma atómica dentro del script Lua
 * de `votes.ts` (junto con la escritura del voto), así que aquí solo
 * queda la obtención de la IP respetando el proxy inverso.
 */

/**
 * Extrae la IP del cliente respetando cabeceras de proxy inverso
 * (Coolify/Traefik ponen `x-forwarded-for`).
 */
export function getClientIp(request: Request, fallback = '0.0.0.0'): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    // Puede venir "client, proxy1, proxy2": nos quedamos con el primero.
    return forwarded.split(',')[0].trim();
  }
  return request.headers.get('x-real-ip')?.trim() || fallback;
}
