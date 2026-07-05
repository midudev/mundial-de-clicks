/**
 * Captcha invisible (Cap) en el cliente.
 *
 * Mejoras clave para que votar NUNCA falle por el WASM:
 *   - WASM y pako SELF-HOSTED (desde /cap/…), no desde un CDN externo:
 *     22KB que cargan en un pestañeo y sin depender de terceros.
 *   - PRE-CALENTADO al cargar la página: si hace falta captcha, se descarga
 *     el widget y el WASM en segundo plano, así al primer click ya está.
 *   - Si el captcha está DESACTIVADO en el servidor (`required=false`), ni
 *     se carga nada: se puede votar directamente.
 */

const API_ENDPOINT = '/api/captcha/';
const WASM_URL = '/cap/cap_wasm_bg.wasm';
const PAKO_URL = '/cap/pako_inflate.min.js';

interface CapInstance {
  solve(): Promise<{ token: string }>;
}
interface CapCtor {
  new (config: { apiEndpoint: string }): CapInstance;
}

/** Vista tipada de los globals que usa/expone Cap (evita augmentar Window). */
interface CapWindow {
  CAP_CUSTOM_WASM_URL?: string;
  CAP_PAKO_URL?: string;
  Cap?: CapCtor;
}
function capWindow(): CapWindow {
  return window as unknown as CapWindow;
}

// Le decimos a Cap que cargue sus assets desde nuestro propio dominio.
if (typeof window !== 'undefined') {
  const w = capWindow();
  w.CAP_CUSTOM_WASM_URL = WASM_URL;
  w.CAP_PAKO_URL = PAKO_URL;
}

let required = true; // por defecto asumimos que hace falta
let verified = false;
let prewarmed = false;
let verifyPromise: Promise<boolean> | null = null;

/** ¿Puede votar? (true si el captcha está off o ya está verificado). */
export function isVerified(): boolean {
  return !required || verified;
}

/** Marca como no verificado (p.ej. si la sesión caducó en el servidor). */
export function resetVerified(): void {
  verified = false;
}

/**
 * Al cargar: averigua si el captcha es obligatorio y si ya hay sesión. Si
 * hace falta y aún no está verificado, precalienta el widget + WASM.
 */
export async function checkSession(): Promise<void> {
  try {
    const res = await fetch('/api/captcha/session');
    const data = (await res.json()) as { required?: boolean; valid?: boolean };
    required = data.required !== false;
    if (required && data.valid) verified = true;
  } catch {
    // Si falla, asumimos que hace falta y se verificará al votar.
  }
  if (required && !verified) void prewarm();
}

/** Descarga el widget y calienta la caché del WASM/pako (no resuelve nada). */
async function prewarm(): Promise<void> {
  if (prewarmed) return;
  prewarmed = true;
  try {
    await Promise.all([
      import('@cap.js/widget'),
      fetch(WASM_URL).catch(() => {}),
      fetch(PAKO_URL).catch(() => {}),
    ]);
  } catch {
    /* si algo falla, se reintentará al resolver */
  }
}

/**
 * Verifica de forma INVISIBLE (PoW en segundo plano). Idempotente: si ya
 * hay una verificación en marcha, reutiliza la misma promesa.
 */
export function verifyInvisible(): Promise<boolean> {
  if (isVerified()) return Promise.resolve(true);
  if (verifyPromise) return verifyPromise;

  verifyPromise = solve().finally(() => {
    verifyPromise = null;
  });
  return verifyPromise;
}

async function solve(): Promise<boolean> {
  showToast();
  try {
    await import('@cap.js/widget'); // registra window.Cap
    const Ctor = capWindow().Cap;
    if (!Ctor) return false;

    const cap = new Ctor({ apiEndpoint: API_ENDPOINT });
    await cap.solve(); // challenge + PoW + redeem (deja la cookie de sesión)
    verified = true;
    return true;
  } catch {
    return false;
  } finally {
    hideToast();
  }
}

/* ---- Toast sutil mientras se verifica ---- */

let toast: HTMLElement | null = null;

function showToast(): void {
  if (toast) return;
  toast = document.createElement('div');
  toast.className = 'verify-toast';
  toast.innerHTML =
    '<span class="verify-toast__spinner"></span> Verificando que eres humano…';
  document.body.appendChild(toast);
}

function hideToast(): void {
  toast?.remove();
  toast = null;
}
