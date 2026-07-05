import type { Country } from './types';

/**
 * Selecciones que llegaron a OCTAVOS DE FINAL del Mundial 2026
 * (USA · Canadá · México). Las 16 clasificadas para la ronda de los
 * mejores 16 tras la fase de grupos y los dieciseisavos.
 *
 * El `code` (ISO 3166-1 alpha-2 en minúsculas) es la clave que se usa
 * en DragonFly y del símbolo de bandera en el sprite (#flag-{code}).
 * Inglaterra usa "en" por convención (no tiene código ISO propio).
 */
export const COUNTRIES: readonly Country[] = [
  { code: 'ar', name: 'Argentina' },
  { code: 'be', name: 'Bélgica' },
  { code: 'br', name: 'Brasil' },
  { code: 'ca', name: 'Canadá' },
  { code: 'co', name: 'Colombia' },
  { code: 'eg', name: 'Egipto' },
  { code: 'es', name: 'España' },
  { code: 'us', name: 'USA' },
  { code: 'fr', name: 'Francia' },
  { code: 'en', name: 'Inglaterra' },
  { code: 'ma', name: 'Marruecos' },
  { code: 'mx', name: 'México' },
  { code: 'no', name: 'Noruega' },
  { code: 'py', name: 'Paraguay' },
  { code: 'pt', name: 'Portugal' },
  { code: 'ch', name: 'Suiza' },
] as const;

/** Mapa code -> Country para búsquedas O(1). */
export const COUNTRY_BY_CODE: ReadonlyMap<string, Country> = new Map(
  COUNTRIES.map((country) => [country.code, country]),
);

/** Conjunto de códigos válidos, para validar votos entrantes. */
export const VALID_CODES: ReadonlySet<string> = new Set(
  COUNTRIES.map((country) => country.code),
);

/** Comprueba si un código corresponde a una selección válida. */
export function isValidCountry(code: string): boolean {
  return VALID_CODES.has(code);
}

/** Nombre visible de un país por su código (o el propio código). */
export function countryName(code: string): string {
  return COUNTRY_BY_CODE.get(code)?.name ?? code;
}
