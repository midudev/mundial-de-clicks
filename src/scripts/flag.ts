/**
 * Crea una bandera en el cliente referenciando el sprite ya inyectado en
 * el HTML: <svg><use href="#flag-{code}" /></svg>. Cero peticiones.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

export function createFlag(
  code: string,
  className: string,
  width: number,
  height: number,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `flag ${className}`.trim());
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('aria-hidden', 'true');

  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#flag-${code}`);
  // Compatibilidad con navegadores que aún esperan xlink:href.
  use.setAttributeNS(XLINK_NS, 'xlink:href', `#flag-${code}`);
  svg.appendChild(use);

  return svg;
}
