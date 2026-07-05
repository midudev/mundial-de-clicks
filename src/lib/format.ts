/**
 * Formateo compacto de números para que la UI NUNCA se rompa por muchos
 * dígitos: 999 → "999", 1.2K, 3.4M, 1.5B, 2T.
 *
 * Función pura y sin dependencias: se usa igual en el servidor (SSR) y
 * en el cliente.
 */

const UNITS: readonly { value: number; suffix: string }[] = [
  { value: 1e12, suffix: 'T' },
  { value: 1e9, suffix: 'B' },
  { value: 1e6, suffix: 'M' },
  { value: 1e3, suffix: 'K' },
];

/** Quita el ".0" sobrante (1.0K → 1K) pero conserva 1.2K. */
function trim(n: number): string {
  return n.toFixed(1).replace(/\.0$/, '');
}

/**
 * Devuelve el número en formato compacto.
 * Por debajo de 1000 se muestra tal cual (con separador de miles opcional
 * desactivado para mantenerlo corto y estable).
 */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const n = Math.max(0, Math.floor(value));

  for (const { value: unit, suffix } of UNITS) {
    if (n >= unit) {
      return `${trim(n / unit)}${suffix}`;
    }
  }
  return String(n);
}
