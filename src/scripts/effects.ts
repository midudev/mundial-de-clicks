/**
 * Efectos visuales de "juice" para gamificar la experiencia:
 *  - "+1" flotante que sube y se desvanece en el punto del click.
 *  - Escalado y color según el combo (clicks rápidos encadenados).
 */

/** Paleta que va del verde al dorado según crece el combo. */
const COMBO_COLORS = ['#4ade80', '#a3e635', '#fbbf24', '#fb923c', '#f87171'];

/**
 * Lanza un "+N" flotante en unas coordenadas de viewport.
 * @param x, y  Coordenadas del click (clientX/clientY).
 * @param combo Racha actual (1 = sin combo).
 */
export function spawnFloatingScore(x: number, y: number, combo: number): void {
  const el = document.createElement('div');
  el.className = 'floating-score';
  el.textContent = combo > 1 ? `+1 ×${combo}` : '+1';

  // Cuanto más alto el combo, más grande y más "caliente" el color.
  const scale = Math.min(1 + (combo - 1) * 0.06, 2.2);
  const color = COMBO_COLORS[Math.min(combo - 1, COMBO_COLORS.length - 1)];
  // Pequeña desviación horizontal aleatoria para que no se solapen.
  const drift = (Math.random() - 0.5) * 24;

  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.setProperty('--scale', String(scale));
  el.style.setProperty('--drift', `${drift}px`);
  el.style.color = color;

  document.body.appendChild(el);
  el.addEventListener('animationend', () => el.remove(), { once: true });
}

/** Dispara la animación de "flash" al subir de puesto en el ranking. */
export function flashRankUp(row: HTMLElement): void {
  row.classList.remove('animate-rank-up');
  void row.offsetWidth; // reinicia la animación
  row.classList.add('animate-rank-up');
}
