/**
 * Avisos visuales de despliegue.
 *
 * Consulta /api/status y pinta un panel con el estado de cada integración
 * (DragonFly, captcha, analytics). Así, al ir creando cada recurso en
 * Coolify y definir su variable de entorno, ves la pieza "encenderse" de
 * ámbar (falta) a verde (conectada).
 */

interface Status {
  dragonfly: boolean;
  captcha: boolean;
  umami: boolean;
  store: 'redis' | 'memory';
}

type FeatureKey = 'dragonfly' | 'captcha' | 'umami';

const ITEMS: { key: FeatureKey; label: string; ok: string; warn: string }[] = [
  {
    key: 'dragonfly',
    label: 'DragonFly',
    ok: 'votos persistentes.',
    warn: 'sin persistencia: los votos viven en memoria y se pierden al reiniciar. Define REDIS_URL.',
  },
  {
    key: 'captcha',
    label: 'Captcha',
    ok: 'protección anti-bot activa.',
    warn: 'desactivado: se vota sin captcha. Apunta CAP_API_URL a tu servidor Cap.',
  },
  {
    key: 'umami',
    label: 'Analytics',
    ok: 'Umami está midiendo visitas.',
    warn: 'sin analytics. Define PUBLIC_UMAMI_* y vuelve a desplegar.',
  },
];

/** Consulta el estado y pinta el panel de avisos. */
export async function renderStatus(): Promise<void> {
  const host = document.getElementById('config-status');
  if (!host) return;

  let status: Status;
  try {
    const res = await fetch('/api/status');
    status = (await res.json()) as Status;
  } catch {
    return; // sin estado no molestamos con avisos
  }

  const rows = ITEMS.map((item) => {
    const ok = status[item.key];
    const msg = ok ? item.ok : item.warn;
    return `<li class="config-status__item ${ok ? 'is-ok' : 'is-warn'}">
        <span class="config-status__dot"></span>
        <span class="config-status__text"><strong>${item.label}</strong> — ${msg}</span>
      </li>`;
  }).join('');

  host.innerHTML = `
    <div class="config-status__head">
      <span class="config-status__title">Estado del despliegue</span>
      <button type="button" class="config-status__close" aria-label="Cerrar avisos">×</button>
    </div>
    <ul class="config-status__list">${rows}</ul>`;
  host.hidden = false;

  host
    .querySelector('.config-status__close')
    ?.addEventListener('click', () => host.remove());
}
