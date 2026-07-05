/**
 * Carga los ficheros `.env.local` / `.env` en `process.env` para desarrollo.
 *
 * ¿Por qué hace falta? Astro/Vite exponen los `.env` en `import.meta.env`,
 * pero NUNCA los inlinean para claves dinámicas ni los vuelcan a
 * `process.env` en el server. Como toda la configuración de runtime se lee
 * de `process.env` (así funciona en producción, donde Coolify/Docker inyecta
 * variables reales), en local necesitamos este puente.
 *
 * Reglas de precedencia (de más a menos prioridad):
 *   1. Variables reales del entorno (shell / contenedor) — NUNCA se pisan.
 *   2. `.env.local`
 *   3. `.env`
 *
 * En producción no se despliega ningún `.env*`, así que esto es un no-op.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

for (const file of ['.env.local', '.env']) {
  if (!existsSync(file)) continue;
  try {
    const parsed = parseEnv(readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      // No pisamos variables ya presentes: el entorno real (y .env.local)
      // mandan sobre .env.
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    /* fichero ausente o malformado: seguimos con lo que haya en el entorno */
  }
}
