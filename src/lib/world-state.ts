import { config } from './config';
import { readWorld } from './votes';
import { formatCompact } from './format';
import type { LiveEvent, RankingEntry, WorldSnapshot } from './types';

/**
 * Estado global del mundial mantenido en memoria del servidor.
 *
 * Un ÚNICO bucle:
 *   1. Lee DragonFly en un solo pipeline (coste constante).
 *   2. Construye el snapshot y detecta eventos.
 *   3. Lo serializa UNA sola vez a bytes con formato SSE.
 *   4. Lo difunde (broadcast) a todas las conexiones SSE suscritas.
 *
 * Ventaja clave: ni la lectura de DragonFly ni la serialización dependen
 * de cuánta gente esté mirando. Da igual 1 espectador que 50.000: se hace
 * una lectura y un `JSON.stringify` por tick. Esto es lo que hace que
 * aguante que "todo internet" esté viendo el ranking a la vez.
 */

const globalForWorld = globalThis as unknown as {
  __mundialWorld?: WorldState;
};

/** Número máximo de eventos recientes que se conservan. */
const MAX_EVENTS = 12;

/** Hitos de votos totales que disparan un evento de celebración. */
const MILESTONES = [1_000, 10_000, 50_000, 100_000, 500_000, 1_000_000];

/** Cada cuánto mandar un ping si no ha cambiado nada (mantener conexión). */
const HEARTBEAT_MS = 20_000;

/** Función que recibe los bytes ya codificados de un snapshot SSE. */
type Subscriber = (payload: Uint8Array) => void;

class WorldState {
  private snapshot: WorldSnapshot = {
    ranking: [],
    totalVotes: 0,
    clicksPerMinute: 0,
    blockedClicks: 0,
    events: [],
  };

  /** Último snapshot de DATOS ya serializado a bytes (`data: ...\n\n`). */
  private payload: Uint8Array | null = null;
  /** JSON del último snapshot enviado, para no reenviar si no cambió. */
  private lastJson = '';
  /** Epoch (ms) del último envío (dato o heartbeat). */
  private lastSentAt = 0;
  private readonly encoder = new TextEncoder();
  /** Comentario keep-alive para conexiones ociosas. */
  private readonly pingPayload = new TextEncoder().encode(': ping\n\n');

  /** Conexiones SSE suscritas. */
  private readonly subscribers = new Set<Subscriber>();

  private events: LiveEvent[] = [];
  private previousPositions = new Map<string, number>();
  private lastMilestone = 0;
  private eventSeq = 0;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private lastRefreshAt = 0;

  /** Arranca el bucle de sondeo (idempotente). */
  start(): void {
    if (this.timer) return;
    // Solo consultamos DragonFly si hay ALGUIEN mirando. Sin espectadores el
    // poller queda dormido (cero carga sobre la BD) y se despierta al primer
    // suscriptor (ver `subscribe`) o ante una petición a `/api/ranking`
    // (que llama a `refresh`). Con el patrón "todo internet o nadie", esto
    // ahorra una lectura por segundo durante los ratos muertos.
    this.timer = setInterval(() => {
      if (this.subscribers.size > 0) void this.refresh();
    }, config.stream.intervalMs);
    this.timer.unref?.();
  }

  /** Último snapshot conocido (para el render SSR inicial). */
  getSnapshot(): WorldSnapshot {
    return this.snapshot;
  }

  /**
   * Suscribe una conexión SSE. Le envía el snapshot actual de inmediato y
   * devuelve una función para darse de baja.
   */
  subscribe(fn: Subscriber): () => void {
    const wasIdle = this.subscribers.size === 0;
    this.subscribers.add(fn);
    if (this.payload) fn(this.payload);
    // Primer espectador tras un rato inactivo: refrescamos ya para no
    // servirle un snapshot viejo (o vacío) hasta el siguiente tick.
    if (wasIdle) void this.refresh();
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** Número de conexiones activas (útil para métricas/logs). */
  get connections(): number {
    return this.subscribers.size;
  }

  /**
   * Consulta DragonFly, recompone el snapshot y lo difunde. Público para que
   * `/api/ranking` pueda forzar un refresco puntual aunque el poller esté
   * dormido por no haber espectadores. El guard `polling` evita solapes.
   */
  async refresh(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.lastRefreshAt = Date.now();
    try {
      const world = await readWorld();

      this.detectOvertakes(world.ranking);
      this.detectMilestones(world.totalVotes);

      this.snapshot = {
        ranking: world.ranking,
        totalVotes: world.totalVotes,
        blockedClicks: world.blockedClicks,
        clicksPerMinute: world.clicksPerMinute,
        events: this.events.slice(0, MAX_EVENTS),
      };

      const json = JSON.stringify(this.snapshot);
      const now = Date.now();

      if (json !== this.lastJson) {
        // Cambió algo: serializa UNA vez y difunde los mismos bytes a todos.
        this.lastJson = json;
        this.payload = this.encoder.encode(`data: ${json}\n\n`);
        this.lastSentAt = now;
        this.broadcast(this.payload);
      } else if (now - this.lastSentAt >= HEARTBEAT_MS) {
        // Nada nuevo: en vez de reenviar el mismo snapshot a miles de
        // espectadores (ancho de banda tirado), solo mandamos un ping
        // para mantener viva la conexión.
        this.lastSentAt = now;
        this.broadcast(this.pingPayload);
      }
    } catch (err) {
      console.error('[world] poll error:', (err as Error).message);
    } finally {
      this.polling = false;
    }
  }

  /** Refresca solo si el último intento ya es suficientemente antiguo. */
  async refreshIfStale(minAgeMs: number): Promise<void> {
    if (Date.now() - this.lastRefreshAt < minAgeMs) return;
    await this.refresh();
  }

  /** Envía un payload a todas las conexiones suscritas. */
  private broadcast(payload: Uint8Array): void {
    for (const fn of this.subscribers) {
      try {
        fn(payload);
      } catch {
        // Una conexión rota no debe tumbar el resto: se limpiará sola
        // cuando su stream aborte.
      }
    }
  }

  /** Detecta cuando un país adelanta a otro y genera un evento. */
  private detectOvertakes(ranking: RankingEntry[]): void {
    if (this.previousPositions.size > 0) {
      for (const entry of ranking) {
        const prev = this.previousPositions.get(entry.code);
        if (
          prev !== undefined &&
          entry.position < prev &&
          entry.position <= 3 &&
          entry.votes > 0
        ) {
          this.pushEvent({
            type: entry.position === 1 ? 'leader' : 'overtake',
            code: entry.code,
            message:
              entry.position === 1
                ? `${entry.name} se pone LÍDER`
                : `${entry.name} sube al puesto #${entry.position}`,
          });
        }
      }
    }

    this.previousPositions = new Map(
      ranking.map((entry) => [entry.code, entry.position]),
    );
  }

  /** Genera un evento al cruzar un hito de votos totales. */
  private detectMilestones(total: number): void {
    for (const milestone of MILESTONES) {
      if (total >= milestone && this.lastMilestone < milestone) {
        this.lastMilestone = milestone;
        this.pushEvent({
          type: 'milestone',
          message: `¡${formatCompact(milestone)} votos totales!`,
        });
      }
    }
  }

  /** Inserta un evento nuevo al principio de la lista. */
  private pushEvent(event: Omit<LiveEvent, 'id' | 'at'>): void {
    this.eventSeq += 1;
    this.events.unshift({
      ...event,
      id: `${Date.now()}-${this.eventSeq}`,
      at: Date.now(),
    });
    if (this.events.length > MAX_EVENTS) {
      this.events.length = MAX_EVENTS;
    }
  }
}

/** Singleton del estado del mundo, ya arrancado. */
export function getWorldState(): WorldState {
  if (!globalForWorld.__mundialWorld) {
    globalForWorld.__mundialWorld = new WorldState();
    globalForWorld.__mundialWorld.start();
  }
  return globalForWorld.__mundialWorld;
}
