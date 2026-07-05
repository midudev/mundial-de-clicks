/**
 * Genera el sprite SVG de banderas a partir de los SVG de `flag-icons`.
 *
 *   node scripts/generate-flag-sprite.mjs
 *
 * Para cada selección:
 *   1. Optimiza el SVG con SVGO (equivalente a SVGOMG).
 *   2. Prefija los ids internos (clipPath/mask) con el código del país
 *      para que no colisionen al meterlos todos en el mismo documento.
 *   3. Lo convierte en un <symbol id="flag-{code}" viewBox="...">.
 *
 * El resultado se escribe en `src/components/FlagSprite.astro`, que se
 * inyecta UNA sola vez en el HTML. Así las banderas ya están en el
 * documento y se referencian con <use href="#flag-{code}"> sin ninguna
 * petición extra.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { optimize } from 'svgo';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Mapea el código usado en la app -> archivo en flag-icons (4x3).
// Inglaterra no tiene ISO propio: usamos gb-eng.
const FLAGS = {
  ar: 'ar', be: 'be', br: 'br', ca: 'ca', co: 'co', eg: 'eg',
  es: 'es', us: 'us', fr: 'fr', en: 'gb-eng', ma: 'ma', mx: 'mx',
  no: 'no', py: 'py', pt: 'pt', ch: 'ch',
};

const FLAGS_DIR = join(root, 'node_modules/flag-icons/flags/4x3');

/** Config de SVGO: optimiza fuerte pero conserva el viewBox. */
function svgoConfig(code) {
  return {
    multipass: true,
    // A 36px de ancho (máx 60px en los retos), coordenadas enteras son
    // imperceptibles y recortan los escudos (México, España) a la mitad.
    floatPrecision: 0,
    plugins: [
      {
        name: 'preset-default',
        params: {
          overrides: {
            // No tocamos ids aquí: los gestiona prefixIds para evitar
            // colisiones al juntar todas las banderas en un documento.
            cleanupIds: false,
            // Recorta decimales de los paths (los escudos son enormes).
            convertPathData: { floatPrecision: 0 },
            cleanupNumericValues: { floatPrecision: 0 },
            convertTransform: { floatPrecision: 0 },
          },
        },
      },
      // Prefija ids internos con el código para evitar colisiones.
      { name: 'prefixIds', params: { prefix: `f${code}`, delim: '-' } },
      // No necesitamos width/height fijos dentro del símbolo.
      'removeDimensions',
    ],
  };
}

/** Extrae el viewBox y el contenido interno de un <svg>. */
function parseSvg(svg) {
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 640 480';
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return { viewBox, inner: inner.trim() };
}

let totalBefore = 0;
let totalAfter = 0;
const symbols = [];

for (const [code, file] of Object.entries(FLAGS)) {
  const raw = await readFile(join(FLAGS_DIR, `${file}.svg`), 'utf8');
  totalBefore += raw.length;

  const { data } = optimize(raw, svgoConfig(code));
  totalAfter += data.length;

  const { viewBox, inner } = parseSvg(data);
  symbols.push(`  <symbol id="flag-${code}" viewBox="${viewBox}">${inner}</symbol>`);
}

const out = `---
// ⚠️ Archivo generado por scripts/generate-flag-sprite.mjs — no editar a mano.
// Sprite SVG de banderas: se inyecta una sola vez en el HTML (ver Layout).
// Las banderas se usan con <use href="#flag-{code}" />.
---

<svg
  xmlns="http://www.w3.org/2000/svg"
  width="0"
  height="0"
  aria-hidden="true"
  style="position:absolute;width:0;height:0;overflow:hidden"
>
${symbols.join('\n')}
</svg>
`;

await writeFile(join(root, 'src/components/FlagSprite.astro'), out, 'utf8');

const kb = (n) => (n / 1024).toFixed(1);
console.log(`✅ Sprite generado: ${symbols.length} banderas`);
console.log(`   SVGO: ${kb(totalBefore)}KB → ${kb(totalAfter)}KB (-${Math.round((1 - totalAfter / totalBefore) * 100)}%)`);
