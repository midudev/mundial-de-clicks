import type { WorldSnapshot } from '../lib/types';
import { sendVotes } from './api';
import { bump, reconcile, revert } from './state';
import {
  renderStats,
  renderRanking,
  renderEvents,
  pulseButton,
  setCooldown,
} from './dom';
import { spawnFloatingScore } from './effects';
import { startChallenge, challengeActive } from './challenge';
import {
  checkSession,
  verifyInvisible,
  resetVerified,
  isVerified,
} from './captcha';
import { renderStatus } from './status';

/**
 * Punto de entrada del cliente.
 *
 * Estrategia para sentir tiempo real Y aguantar carga:
 *   - Cada click actualiza la UI AL INSTANTE (estado optimista + efectos).
 *   - Los votos NO se envían uno a uno: se acumulan y se mandan en LOTE
 *     cada `FLUSH_MS`. Así 20 clicks/seg no son 20 peticiones, sino ~7
 *     con un contador. Es la mayor optimización de carga posible.
 *   - El servidor manda snapshots por SSE y reconciliamos de forma
 *     monotónica (los números solo suben, sin parpadeos).
 */

// --- Configuración de batching y combos ------------------------------
// Batching por VENTANA FIJA (throttle): con el primer click se abre una
// ventana de FLUSH_MS; TODOS los clicks que caigan dentro se acumulan y
// se mandan de golpe al cerrarse. Así, por muy rápido que cliques, sale
// como mucho una petición cada FLUSH_MS. Como la UI es optimista (el voto
// se ve al instante), esta espera no se nota.
const FLUSH_MS = 400; // duración de la ventana de agrupado
const MAX_SEND_BATCH = 10; // debe mantenerse alineado con /api/vote
const MAX_SEND_COUNTRIES = 3; // debe mantenerse alineado con /api/vote
const COMBO_WINDOW_MS = 700; // ventana para encadenar combo

// Retos: en vez de un número fijo, un intervalo ALEATORIO de votos entre
// reto y reto. Así salen más espaciados y de forma menos predecible (más
// "de vez en cuando" y no como un reloj cada X clicks).
const CHALLENGE_MIN = 60;
const CHALLENGE_MAX = 110;
const nextChallengeAt = () =>
  CHALLENGE_MIN + Math.floor(Math.random() * (CHALLENGE_MAX - CHALLENGE_MIN + 1));

// --- Estado de los retos ---------------------------------------------
let votesSinceChallenge = 0;
let challengeThreshold = nextChallengeAt();

// --- Estado del lote pendiente de envío ------------------------------
const pending = new Map<string, number>();
let flushTimer: number | null = null;

// --- Backoff del captcha ---------------------------------------------
// Si el captcha falla de forma persistente (backend caído, red bloqueada,
// ruta mal configurada…) el servidor devuelve `captcha_required` una y otra
// vez. SIN backoff, el cliente re-resolvería un PoW cada 300ms para siempre:
// un loop infinito que funde CPU y hace parpadear el toast. Con esto, cada
// fallo consecutivo espera el doble (hasta un tope) y se resetea al primer
// éxito. Los votos NO se pierden: siguen en `pending` hasta que se acepten.
let captchaFailures = 0;
const CAPTCHA_BACKOFF_MAX_MS = 20_000;
function captchaBackoff(): number {
  return Math.min(400 * 2 ** captchaFailures, CAPTCHA_BACKOFF_MAX_MS);
}

// --- Estado del combo ------------------------------------------------
let combo = 0;
let lastClickAt = 0;
let comboResetTimer: number | null = null;

// --- Cooldown por rate limit -----------------------------------------
let cooldownUntil = 0;
const isCoolingDown = () => Date.now() < cooldownUntil;

/** Programa un envío del lote si no hay ya uno programado. */
function scheduleFlush(delay = FLUSH_MS): void {
  if (flushTimer === null) {
    flushTimer = window.setTimeout(flush, delay);
  }
}

/** Acumula un voto en el lote y programa su envío. */
function queueVote(code: string): void {
  pending.set(code, (pending.get(code) ?? 0) + 1);
  scheduleFlush();
}

/** Extrae del acumulado un lote acotado, dejando el resto para otro envío. */
function takePendingBatch(maxVotes: number, maxCountries: number): Map<string, number> {
  const batch = new Map<string, number>();
  let remaining = maxVotes;

  for (const [code, count] of Array.from(pending)) {
    if (remaining <= 0 || batch.size >= maxCountries) break;
    const take = Math.min(count, remaining);
    batch.set(code, take);
    remaining -= take;

    if (take === count) {
      pending.delete(code);
    } else {
      pending.set(code, count - take);
    }
  }

  return batch;
}

/** true mientras hay un envío/verificación en curso (un solo lote a la vez). */
let sending = false;

/**
 * Envía el lote acumulado. Garantías:
 *   - Solo UN envío en curso a la vez (guard `sending`): los clicks que
 *     llegan durante una verificación/envío se acumulan y salen en el
 *     siguiente lote. Nunca hay dobles envíos ni errores de carrera.
 *   - Los votos NUNCA se pierden: si el captcha aún no está listo o falla,
 *     el lote se mantiene en `pending` y se reintenta.
 */
async function flush(): Promise<void> {
  flushTimer = null;
  if (sending || pending.size === 0) return;
  sending = true;

  // Reintento tras terminar (0 = ninguno salvo que quede pendiente).
  let retryDelay = 0;

  try {
    // Captcha invisible: la 1ª vez resolvemos el PoW en segundo plano (con
    // el WASM ya precalentado). Si falla, reintentamos sin perder votos.
    if (!isVerified()) {
      const ok = await verifyInvisible();
      if (!ok) {
        // No se pudo resolver el PoW (challenge/redeem caídos o bloqueados):
        // backoff para no martillear en bucle.
        captchaFailures += 1;
        retryDelay = captchaBackoff();
        return;
      }
    }

    const batch = takePendingBatch(MAX_SEND_BATCH, MAX_SEND_COUNTRIES);

    const res = await sendVotes(batch);

    // Sesión caducada/ausente en el servidor: reverificamos y reencolamos el
    // lote. Con backoff exponencial para no entrar en un loop apretado si el
    // captcha está roto (backend inalcanzable, ruta mal, etc.).
    if (res.reason === 'captcha_required') {
      resetVerified();
      for (const [code, count] of batch) {
        pending.set(code, (pending.get(code) ?? 0) + count);
      }
      captchaFailures += 1;
      retryDelay = captchaBackoff();
      return;
    }

    // Llegamos aquí = el captcha no fue el problema (voto procesado o rate
    // limit). Reseteamos el contador de fallos.
    if (res.ok || res.reason === 'rate_limited') captchaFailures = 0;

    // Re-sincronización con la BD: el servidor es la autoridad. Todo voto
    // del lote que NO haya contado (bloqueado por rate limit, o perdido por
    // un error de red) se revierte del estado optimista. Sin esto, "Votos
    // Totales" y el ranking quedan inflados para siempre, porque reconcile
    // solo sube. `accepted` es 0 en rate_limited/error → se revierte el lote
    // entero.
    const reverted = revertUnaccepted(batch, res.accepted ?? 0);
    if (reverted > 0) {
      renderStats();
      renderRanking();
    }

    // Rate limit: cooldown para dejar de spamear la red.
    if (res.reason === 'rate_limited' && res.retryAfter) {
      cooldownUntil = Date.now() + res.retryAfter;
      setCooldown(true);
      window.setTimeout(() => {
        if (!isCoolingDown()) setCooldown(false);
      }, res.retryAfter + 50);
    }
  } finally {
    sending = false;
    if (pending.size > 0) scheduleFlush(retryDelay || FLUSH_MS);
  }
}

/**
 * Revierte del estado optimista los votos de un lote que el servidor no
 * aceptó. Reparte `accepted` entre los países EN EL MISMO ORDEN en que el
 * servidor consume el cupo (orden de inserción del lote, idéntico al ARGV
 * del script Lua): los primeros países agotan el presupuesto y el resto
 * queda bloqueado. Devuelve cuántos votos se revirtieron.
 */
function revertUnaccepted(batch: Map<string, number>, accepted: number): number {
  let budget = accepted;
  let reverted = 0;
  for (const [code, requested] of batch) {
    const ok = Math.min(requested, budget);
    budget -= ok;
    const blocked = requested - ok;
    if (blocked > 0) {
      revert(code, blocked);
      reverted += blocked;
    }
  }
  return reverted;
}

/** Actualiza el combo según el ritmo de clicks. */
function updateCombo(): number {
  const now = Date.now();
  combo = now - lastClickAt < COMBO_WINDOW_MS ? combo + 1 : 1;
  lastClickAt = now;

  if (comboResetTimer !== null) window.clearTimeout(comboResetTimer);
  comboResetTimer = window.setTimeout(() => {
    combo = 0;
  }, COMBO_WINDOW_MS);

  return combo;
}

/** Maneja un click sobre un botón de voto. */
function handleVote(button: HTMLElement, code: string, x: number, y: number): void {
  // Con reto en curso o en cooldown, no se vota. El captcha NO bloquea el
  // click: se resuelve invisible al enviar el primer lote (ver flush).
  if (challengeActive() || isCoolingDown()) return;

  // 1. Feedback inmediato (optimista): estado + UI + efectos.
  bump(code);
  const currentCombo = updateCombo();
  pulseButton(button);
  spawnFloatingScore(x, y, currentCombo);
  renderRanking();
  renderStats();

  // 2. Encolar para envío en lote.
  queueVote(code);

  // 3. ¿Toca reto? Cada cierto número (aleatorio) de votos, uno.
  votesSinceChallenge += 1;
  if (votesSinceChallenge >= challengeThreshold) {
    votesSinceChallenge = 0;
    challengeThreshold = nextChallengeAt(); // recalcula el próximo umbral
    void flush(); // manda lo pendiente antes de bloquear
    startChallenge(() => {
      /* al resolver, simplemente se puede seguir votando */
    });
  }
}

/** Configura el manejo de clicks por delegación en el contenedor. */
function setupVoting(): void {
  const grid = document.getElementById('voting-grid');
  if (!grid) return;

  grid.addEventListener('pointerdown', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-vote]',
    );
    if (!button) return;
    const code = button.dataset.vote;
    if (code) handleVote(button, code, event.clientX, event.clientY);
  });
}

/** Conecta el stream SSE y reconcilia el estado en cada snapshot. */
function setupStream(): void {
  const source = new EventSource('/api/stream');

  source.addEventListener('message', (event) => {
    let snapshot: WorldSnapshot;
    try {
      snapshot = JSON.parse(event.data) as WorldSnapshot;
    } catch {
      return;
    }
    reconcile(snapshot);
    renderStats();
    renderRanking();
    renderEvents(snapshot);
  });

  source.addEventListener('error', () => {
    console.warn('[sse] conexión interrumpida, reintentando…');
  });
}

/** Envía lo que quede pendiente antes de cerrar la pestaña. */
function setupUnloadFlush(): void {
  window.addEventListener('pagehide', () => {
    if (pending.size > 0) void flush();
  });
}

function init(): void {
  setupVoting();
  setupStream();
  setupUnloadFlush();
  // Si ya hay sesión válida (votó hace poco), queda verificado sin hacer
  // nada. Si no, la verificación invisible salta al primer voto.
  void checkSession();
  // Avisos de despliegue: qué está configurado y qué falta.
  void renderStatus();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
