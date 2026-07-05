/**
 * Tipos compartidos en toda la aplicación.
 * Fuente única de verdad para la forma de los datos que viajan
 * entre el servidor (API + DragonFly) y el cliente.
 */

/** Una selección participante en el Mundial de Clicks. */
export interface Country {
  /** Código ISO en minúsculas, ej. "es". Clave en DragonFly y del símbolo
   *  de bandera en el sprite (#flag-{code}). */
  code: string;
  /** Nombre visible, ej. "España". */
  name: string;
}

/** Una fila del ranking con su posición y total de votos. */
export interface RankingEntry extends Country {
  /** Total de votos acumulados. */
  votes: number;
  /** Posición actual (1 = líder). */
  position: number;
}

/** Evento de la retransmisión en directo (adelantamientos, hitos...). */
export interface LiveEvent {
  id: string;
  type: 'overtake' | 'milestone' | 'leader';
  message: string;
  /** Código del país protagonista (para pintar su bandera), si aplica. */
  code?: string;
  /** Epoch en milisegundos. */
  at: number;
}

/** Snapshot completo del estado del mundial en un instante. */
export interface WorldSnapshot {
  ranking: RankingEntry[];
  totalVotes: number;
  clicksPerMinute: number;
  blockedClicks: number;
  events: LiveEvent[];
}

/** Respuesta del endpoint de voto (soporta lotes). */
export interface VoteResponse {
  ok: boolean;
  /** Votos totales por país tras aplicar el lote (si ok). */
  counts?: Record<string, number>;
  /** Votos aceptados del lote. */
  accepted?: number;
  /** Votos bloqueados del lote por rate limit. */
  blocked?: number;
  /** Clicks restantes en la ventana de rate limit. */
  remaining?: number;
  /** Motivo del rechazo total (si !ok). */
  reason?:
    | 'rate_limited'
    | 'invalid_payload'
    | 'payload_too_large'
    | 'captcha_required'
    | 'error';
  /** Milisegundos hasta poder reintentar (si rate_limited). */
  retryAfter?: number;
}

/** Resultado de una comprobación de rate limit con coste N. */
export interface RateLimitResult {
  /** Cuántos votos del coste solicitado se permiten. */
  allowed: number;
  /** Cuántos se bloquean. */
  blocked: number;
  /** Clicks restantes en la ventana tras consumir. */
  remaining: number;
  /** Milisegundos hasta que se libere un hueco. */
  retryAfter: number;
}
