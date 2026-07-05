import type { LiveEvent, WorldSnapshot } from '../lib/types';
import { formatCompact } from '../lib/format';
import { getRanking, getStats } from './state';
import { flashRankUp } from './effects';
import { createFlag } from './flag';

/**
 * Capa de renderizado: traduce el estado (optimista) a cambios en el DOM.
 * Toda la manipulación del DOM vive aquí.
 */

/** Últimas posiciones conocidas, para detectar ascensos y hacer flash. */
const lastPositions = new Map<string, number>();

/** Iconos por tipo de evento del directo. */
const EVENT_ICON: Record<LiveEvent['type'], string> = {
  leader: '👑',
  overtake: '⬆️',
  milestone: '🔥',
};

/** Actualiza la barra de estadísticas globales (formato compacto). */
export function renderStats(): void {
  const { total, clicksPerSecond, blocked } = getStats();
  setStat('total', total);
  setStat('cps', clicksPerSecond);
  setStat('blocked', blocked);
}

function setStat(key: string, value: number): void {
  const el = document.querySelector<HTMLElement>(`[data-stat="${key}"]`);
  if (el) el.textContent = formatCompact(value);
}

/**
 * Reordena y actualiza el ranking desde el estado local. Se llama tanto
 * en cada click (optimista) como al llegar un snapshot (reconciliado).
 */
export function renderRanking(): void {
  const ranking = getRanking();
  const maxVotes = Math.max(1, ...ranking.map((r) => r.votes));

  for (const entry of ranking) {
    const row = document.querySelector<HTMLElement>(
      `[data-row="${entry.code}"]`,
    );
    if (!row) continue;

    // Reordenar con CSS order (el contenedor es flex column).
    row.style.order = String(entry.position);

    // Flash al mejorar de posición.
    const prev = lastPositions.get(entry.code);
    if (prev !== undefined && entry.position < prev && entry.votes > 0) {
      flashRankUp(row);
    }
    lastPositions.set(entry.code, entry.position);

    // Corona + glow para el líder.
    row.classList.toggle('is-leader', entry.position === 1 && entry.votes > 0);

    const pos = row.querySelector<HTMLElement>('[data-pos]');
    if (pos) pos.textContent = badge(entry.position);

    const bar = row.querySelector<HTMLElement>('[data-bar]');
    if (bar) bar.style.width = `${(entry.votes / maxVotes) * 100}%`;

    const count = row.querySelector<HTMLElement>('[data-count]');
    if (count) count.textContent = formatCompact(entry.votes);

    // Resalta también la tarjeta de voto del líder.
    const card = document.querySelector<HTMLElement>(
      `[data-vote="${entry.code}"]`,
    );
    card?.classList.toggle(
      'is-leader',
      entry.position === 1 && entry.votes > 0,
    );
  }
}

function badge(position: number): string {
  if (position === 1) return '👑';
  if (position === 2) return '🥈';
  if (position === 3) return '🥉';
  return `#${position}`;
}

/** IDs de los eventos actualmente pintados, en orden. */
let renderedEventIds: string[] = [];

/**
 * Renderiza el ticker del directo SIN parpadeo:
 *  - Si la lista de eventos no ha cambiado, no toca el DOM.
 *  - Si cambió, reutiliza los nodos existentes (por id), inserta los
 *    nuevos con animación de entrada y usa FLIP para que los que ya
 *    estaban se DESLICEN suavemente a su nueva posición.
 */
export function renderEvents(snapshot: WorldSnapshot): void {
  const list = document.getElementById('events-list');
  if (!list || snapshot.events.length === 0) return;

  const events = snapshot.events;
  const newIds = events.map((e) => e.id);

  // Sin cambios → no re-renderizamos (evita el parpadeo).
  if (sameOrder(newIds, renderedEventIds)) return;

  // Quita el placeholder inicial si sigue ahí.
  list.querySelector('[data-empty]')?.remove();

  // Nodos existentes indexados por id de evento.
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(list.children) as HTMLElement[]) {
    if (child.dataset.eventId) existing.set(child.dataset.eventId, child);
  }

  // FLIP (1/2): posición inicial de los nodos que se reutilizan.
  const firstTop = new Map<string, number>();
  for (const [id, el] of existing) {
    firstTop.set(id, el.getBoundingClientRect().top);
  }

  // Construye el orden deseado, reutilizando o creando nodos.
  const desired: HTMLElement[] = [];
  const created = new Set<HTMLElement>();
  for (const event of events) {
    let node = existing.get(event.id);
    if (!node) {
      node = buildEventItem(event);
      created.add(node);
    }
    desired.push(node);
  }

  // Elimina los nodos que ya no están en el snapshot.
  const keep = new Set(desired);
  for (const child of Array.from(list.children) as HTMLElement[]) {
    if (!keep.has(child)) child.remove();
  }

  // Reordena en el DOM (appendChild mueve los nodos existentes).
  for (const node of desired) list.appendChild(node);

  // FLIP (2/2): invierte y reproduce el desplazamiento de los reutilizados.
  for (const node of desired) {
    if (created.has(node)) {
      node.classList.add('animate-slide-in');
      node.addEventListener(
        'animationend',
        () => node.classList.remove('animate-slide-in'),
        { once: true },
      );
      continue;
    }
    const id = node.dataset.eventId;
    const before = id ? firstTop.get(id) : undefined;
    if (before === undefined) continue;
    const delta = before - node.getBoundingClientRect().top;
    if (delta === 0) continue;

    node.style.transition = 'none';
    node.style.transform = `translateY(${delta}px)`;
    requestAnimationFrame(() => {
      node.style.transition = 'transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)';
      node.style.transform = '';
    });
  }

  renderedEventIds = newIds;
}

/** Compara dos listas de ids (mismo contenido y orden). */
function sameOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function buildEventItem(event: LiveEvent): HTMLElement {
  const li = document.createElement('li');
  li.className = `event event--${event.type}`;
  li.dataset.eventId = event.id;

  if (event.code) {
    li.appendChild(createFlag(event.code, 'event__flag', 20, 15));
  } else {
    const icon = document.createElement('span');
    icon.className = 'event__icon';
    icon.textContent = EVENT_ICON[event.type];
    li.appendChild(icon);
  }

  const text = document.createElement('span');
  text.textContent = event.message;
  li.appendChild(text);
  return li;
}

/** Feedback visual al pulsar un botón de voto. */
export function pulseButton(button: HTMLElement): void {
  button.classList.remove('animate-pop');
  void button.offsetWidth; // reinicia la animación en clicks rápidos
  button.classList.add('animate-pop');
}

/** Marca la grilla en cooldown (rate limit) visualmente. */
export function setCooldown(active: boolean): void {
  const grid = document.getElementById('voting-grid');
  grid?.classList.toggle('is-cooldown', active);
}
