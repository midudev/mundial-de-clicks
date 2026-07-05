import type { WorldSnapshot } from '../lib/types';
import { sendVotes } from './api';
import { bump, reconcile } from './state';
import {
  renderStats,
  renderRanking,
  renderEvents,
  pulseButton,
  setCooldown,
} from './dom';
import { spawnFloatingScore } from './effects';
import { startChallenge, challengeActive } from './challenge';

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

// --- Estado del combo ------------------------------------------------
let combo = 0;
let lastClickAt = 0;
let comboResetTimer: number | null = null;

// --- Cooldown por rate limit -----------------------------------------
let cooldownUntil = 0;
const isCoolingDown = () => Date.now() < cooldownUntil;

/** Acumula un voto en el lote. Abre la ventana de agrupado si no hay una. */
function queueVote(code: string): void {
  pending.set(code, (pending.get(code) ?? 0) + 1);
  // Solo se programa un flush por ventana: los clicks siguientes caen en
  // el mismo lote hasta que la ventana se cierra.
  if (flushTimer === null) {
    flushTimer = window.setTimeout(flush, FLUSH_MS);
  }
}

/** Envía el lote acumulado al servidor. */
async function flush(): Promise<void> {
  flushTimer = null;
  if (pending.size === 0) return;

  const batch = new Map(pending);
  pending.clear();

  const res = await sendVotes(batch);

  // Si nos frenan, entramos en cooldown para dejar de spamear la red.
  if (res.reason === 'rate_limited' && res.retryAfter) {
    cooldownUntil = Date.now() + res.retryAfter;
    setCooldown(true);
    window.setTimeout(() => {
      if (!isCoolingDown()) setCooldown(false);
    }, res.retryAfter + 50);
  }
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
  // Si hay un reto en curso o estamos en cooldown, no se puede votar.
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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
