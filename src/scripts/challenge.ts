import { COUNTRIES } from '../lib/countries';
import { createFlag } from './flag';

/**
 * Sistema de RETOS con temática futbolera: cada cierto número de votos
 * aparece un reto que hay que resolver para seguir votando. Gamifica y,
 * de paso, hace de barrera anti-bot.
 *
 * Retos disponibles (elegidos al azar, el penalti pesa más):
 *   1. ⚽ Penalti: marca gol eligiendo dónde chutar mientras el portero
 *      se lanza a un palo al azar.
 *   2. 🚩 Adivina la bandera de la selección.
 */

let active = false;

/** ¿Hay un reto en curso bloqueando el voto? */
export function challengeActive(): boolean {
  return active;
}

/** Entero aleatorio en [0, max). */
function randInt(max: number): number {
  return Math.floor(Math.random() * max);
}

/** Baraja una copia del array (Fisher-Yates). */
function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Lanza un reto. Bloquea hasta que el usuario lo supera; entonces cierra
 * el overlay y llama a `onSolved`.
 */
export function startChallenge(onSolved: () => void): void {
  if (active) return;
  active = true;

  const overlay = document.createElement('div');
  overlay.className = 'challenge-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const card = document.createElement('div');
  card.className = 'challenge-card';
  overlay.appendChild(card);

  const solve = () => {
    if (!active) return;
    active = false;
    overlay.classList.add('challenge-overlay--out');
    setTimeout(() => overlay.remove(), 200);
    onSolved();
  };

  const fail = () => {
    card.classList.remove('challenge-card--shake');
    void card.offsetWidth;
    card.classList.add('challenge-card--shake');
  };

  // El penalti aparece con más frecuencia (es el más divertido).
  const builders = [
    renderPenaltyChallenge,
    renderPenaltyChallenge,
    renderFlagChallenge,
  ];
  builders[randInt(builders.length)](card, solve, fail);

  document.body.appendChild(overlay);
}

/** Cabecera común de los retos. */
function header(card: HTMLElement, title: string, question: string): void {
  const h = document.createElement('p');
  h.className = 'challenge-title font-pixel';
  h.textContent = title;

  const q = document.createElement('p');
  q.className = 'challenge-question';
  q.innerHTML = question;

  card.append(h, q);
}

/* ==== Reto estrella: PENALTI ======================================== */

function renderPenaltyChallenge(
  card: HTMLElement,
  solve: () => void,
  fail: () => void,
): void {
  header(card, '⚽ PENALTI', 'Marca gol para seguir votando. ¡Elige palo!');

  const pitch = document.createElement('div');
  pitch.className = 'penalty';
  pitch.innerHTML = `
    <div class="penalty__goal"></div>
    <div class="penalty__keeper" data-keeper>🧤</div>
    <div class="penalty__result" data-result></div>
    <div class="penalty__ball" data-ball>⚽</div>
    <div class="penalty__zones">
      <button type="button" class="penalty__zone" data-zone="0" aria-label="Chutar a la izquierda"></button>
      <button type="button" class="penalty__zone" data-zone="1" aria-label="Chutar al centro"></button>
      <button type="button" class="penalty__zone" data-zone="2" aria-label="Chutar a la derecha"></button>
    </div>
    <p class="penalty__hint">👈 izquierda · centro · derecha 👉</p>
  `;
  card.appendChild(pitch);

  const keeper = pitch.querySelector<HTMLElement>('[data-keeper]')!;
  const ball = pitch.querySelector<HTMLElement>('[data-ball]')!;
  const result = pitch.querySelector<HTMLElement>('[data-result]')!;
  const zones = Array.from(
    pitch.querySelectorAll<HTMLButtonElement>('.penalty__zone'),
  );

  // Centros de cada palo en % del ancho de la portería.
  const ZONE_X = [18, 50, 82];
  let shooting = false;

  const shoot = (shotIdx: number) => {
    if (shooting) return;
    shooting = true;

    // El portero se lanza a un palo al azar (2/3 de marcar).
    const keeperIdx = randInt(3);
    keeper.style.left = `${ZONE_X[keeperIdx]}%`;

    // El balón vuela hacia el palo elegido.
    const pitchRect = pitch.getBoundingClientRect();
    const zoneRect = zones[shotIdx].getBoundingClientRect();
    const dx =
      zoneRect.left + zoneRect.width / 2 - (pitchRect.left + pitchRect.width / 2);
    ball.style.transform = `translate(calc(-50% + ${dx}px), -110px) scale(0.65)`;

    window.setTimeout(() => {
      if (keeperIdx === shotIdx) {
        // ¡Parada!
        result.textContent = '🧤 ¡PARADÓN!';
        result.classList.add('penalty__result--save');
        fail();
        // Reinicia para intentarlo otra vez.
        window.setTimeout(() => {
          ball.style.transform = '';
          keeper.style.left = '50%';
          result.textContent = '';
          result.classList.remove('penalty__result--save');
          shooting = false;
        }, 900);
      } else {
        // ¡GOL!
        result.textContent = '⚽ ¡GOOOL!';
        result.classList.add('penalty__result--goal');
        window.setTimeout(solve, 750);
      }
    }, 430);
  };

  zones.forEach((zone) => {
    zone.addEventListener('click', () => shoot(Number(zone.dataset.zone)));
  });
}

/* ==== Adivina la bandera ============================================ */

function renderFlagChallenge(
  card: HTMLElement,
  solve: () => void,
  fail: () => void,
): void {
  const picks = shuffle(COUNTRIES).slice(0, 3);
  const target = picks[randInt(picks.length)];

  header(
    card,
    '🚩 ¿QUÉ SELECCIÓN ES?',
    `Toca la bandera de <strong>${target.name}</strong>`,
  );

  const row = document.createElement('div');
  row.className = 'challenge-options';
  for (const country of shuffle(picks)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'challenge-option challenge-option--flag';
    btn.setAttribute('aria-label', country.name);
    btn.appendChild(createFlag(country.code, 'challenge-flag', 60, 45));

    btn.addEventListener('click', () =>
      country.code === target.code ? solve() : fail(),
    );
    row.appendChild(btn);
  }
  card.appendChild(row);
}
