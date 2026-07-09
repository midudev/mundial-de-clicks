/**
 * Lectura del cuerpo de una petición con un tope DURO de bytes.
 *
 * Defensa contra DoS de memoria: NO nos fiamos del `Content-Length` (se puede
 * mentir u omitir con `Transfer-Encoding: chunked`). Contamos los bytes según
 * llegan y abortamos el stream en cuanto se pasa, así nunca buffeamos megas en
 * memoria. El middleware global solo mira el `Content-Length` declarado, que es
 * salteable; este lector es la defensa real y va en cada endpoint que lea body.
 */

/** Lee el body como texto, o `null` si excede `maxBytes`. */
export async function readBodyLimited(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  if (!request.body) {
    const text = await request.text();
    return Buffer.byteLength(text) > maxBytes ? null : text;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/**
 * Igual que `readBodyLimited` pero devuelve el JSON parseado, o `null` si el
 * body excede el tope o no es JSON válido. El llamante distingue "demasiado
 * grande" de "JSON inválido" solo si lo necesita; para la mayoría, null → 400.
 */
export async function readJsonLimited(
  request: Request,
  maxBytes: number,
): Promise<unknown | null> {
  const text = await readBodyLimited(request, maxBytes);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
