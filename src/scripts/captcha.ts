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
  CAP_CUSTOM_FETCH?: (url: string, opts?: RequestInit) => Promise<Response>;
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

  // Fetch propio para las peticiones del widget: fuerza `Content-Type:
  // application/json`. El challenge iba SIN content-type, y el navegador lo
  // manda como `text/plain`, uno de los tipos que dispara la protección CSRF
  // `checkOrigin` de Astro (que además falla tras el proxy inverso porque el
  // `Origin` https no coincide con el `url.origin` http interno) → 403.
  // Con JSON, Astro exime la comprobación cross-origin y el reto pasa a 200,
  // manteniendo la CSRF activa para el resto de la app. `apiEndpoint` se pasa
  // por config, así que definir este fetch NO cambia la ruta del widget.
  w.CAP_CUSTOM_FETCH = (url, opts = {}) =>
    fetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    });
}

let required = true; // por defecto asumimos que hace falta
// `hasSession`: creemos que el servidor tiene una sesión de voto viva. NO es
// lo mismo que "resolví un PoW": la sesión solo existe DESPUÉS de que el
// servidor valide (y consuma) un token en /api/vote. Como la ventana es corta
// y no renovable, esto se pone a false cuando el servidor pide captcha.
let hasSession = false;
// Token de captcha de un solo uso, resuelto y listo para adjuntar al próximo
// voto. Se limpia en cuanto se consume (`takeToken`).
let pendingToken: string | null = null;
let prewarmed = false;
let verifyPromise: Promise<boolean> | null = null;

/** ¿Puede votar sin adjuntar token? (captcha off o sesión viva). */
export function isVerified(): boolean {
  return !required || hasSession;
}

/** El servidor aceptó un voto → hay sesión viva. */
export function markVerified(): void {
  hasSession = true;
}

/** Marca que no hay sesión (p.ej. el servidor pidió captcha de nuevo). */
export function resetVerified(): void {
  hasSession = false;
}

/**
 * Entrega el token de un solo uso pendiente (y lo limpia). El llamador lo
 * adjunta al voto; una vez enviado, no se puede reutilizar.
 */
export function takeToken(): string | null {
  const t = pendingToken;
  pendingToken = null;
  return t;
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
    if (required && data.valid) hasSession = true;
  } catch {
    // Si falla, asumimos que hace falta y se verificará al votar.
  }
  if (required && !hasSession) void prewarm();
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
 * Asegura de forma INVISIBLE que hay un token de un solo uso listo para
 * adjuntar al próximo voto (PoW en segundo plano). Idempotente: si ya hay
 * sesión, o ya hay un token pendiente, o una resolución en marcha, no
 * resuelve otro PoW. Devuelve true si se puede votar (sesión o token listo).
 */
export function verifyInvisible(): Promise<boolean> {
  if (isVerified() || pendingToken) return Promise.resolve(true);
  if (verifyPromise) return verifyPromise;

  verifyPromise = solve().finally(() => {
    verifyPromise = null;
  });
  return verifyPromise;
}

/**
 * Resuelve el PoW y guarda el token resultante en `pendingToken`. NO marca
 * sesión: la sesión solo existe cuando el servidor valida el token al votar.
 */
async function solve(): Promise<boolean> {
  showToast();
  try {
    await import('@cap.js/widget'); // registra window.Cap
    const Ctor = capWindow().Cap;
    if (!Ctor) return false;

    const cap = new Ctor({ apiEndpoint: API_ENDPOINT });
    const res = await cap.solve(); // challenge + PoW + redeem → token
    if (!res?.token) return false;
    pendingToken = res.token;
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
