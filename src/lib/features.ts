/**
 * Qué integraciones están configuradas.
 *
 * FILOSOFÍA: la app funciona SIN nada configurado (modo demo en memoria) y
 * va "encendiendo" piezas a medida que defines sus variables de entorno.
 * Cada flag alimenta un aviso visual en la web (ver `/api/status`), para
 * que al desplegar veas de un vistazo qué está conectado y qué no.
 *
 *   · DragonFly  → persistencia de votos. Sin él: votos en memoria.
 *   · Captcha    → protección anti-bot (Cap). Sin él: se vota sin captcha.
 *   · Umami      → analytics. Sin él: no se inyecta el script.
 */

// Vuelca los `.env*` a process.env en local (no-op en producción). Debe ir
// ANTES de leer cualquier flag de process.env de este módulo.
import './load-env';

/** true si la variable existe y no está vacía. */
function has(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * ¿Hay DragonFly configurado? Si no, la app usa un store en memoria: se
 * puede votar (y se ve el ranking moverse), pero NO hay persistencia.
 */
export const hasDragonfly: boolean =
  has(process.env.REDIS_URL) || has(process.env.DRAGONFLY_HOST);

/**
 * ¿Captcha activo? Se enciende apuntando `CAP_API_URL` a un servidor Cap
 * standalone ({URL}/{siteKey}) y necesita DragonFly (ahí viven las sesiones
 * verificadas). Sin él, se vota sin captcha.
 */
export const hasCaptcha: boolean =
  has(process.env.CAP_API_URL) && hasDragonfly;

/**
 * ¿Analytics de Umami? Son PUBLIC_* → se leen en BUILD (import.meta.env),
 * así que cambiarlas exige volver a desplegar.
 */
export const hasUmami: boolean =
  has(import.meta.env.PUBLIC_UMAMI_SCRIPT_URL) &&
  has(import.meta.env.PUBLIC_UMAMI_WEBSITE_ID);

/** Estado de las features para el cliente (avisos visuales). */
export interface FeatureStatus {
  /** Persistencia de votos activa. */
  dragonfly: boolean;
  /** Captcha anti-bot activo. */
  captcha: boolean;
  /** Analytics activo. */
  umami: boolean;
  /** Store en uso: 'redis' (DragonFly) o 'memory' (demo). */
  store: 'redis' | 'memory';
}

/** Snapshot del estado de configuración. */
export function featureStatus(): FeatureStatus {
  return {
    dragonfly: hasDragonfly,
    captcha: hasCaptcha,
    umami: hasUmami,
    store: hasDragonfly ? 'redis' : 'memory',
  };
}
