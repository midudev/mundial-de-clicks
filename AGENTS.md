## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Anti-abuso (integridad de votos)

Todo el anti-abuso del voto (rate limit, cap diario, IP de la `cap_session`)
se llavea con `CF-Connecting-IP`. Esa cabecera solo es fiable si el request
demostró haber pasado por Cloudflare, cosa que certifica el **origin guard**:

- `ORIGIN_GUARD_SECRET` es **obligatoria en producción**. El middleware
  (`src/middleware.ts`) exige el header `x-origin-guard` (inyectado por una
  Transform Rule de Cloudflare) en toda ruta salvo `/api/health`. Sin el
  secreto configurado en prod, `/api/vote` y `/api/captcha/*` fallan cerrados
  (`503`) en vez de servirse con una IP spoofeable.
- No confiar nunca en `X-Forwarded-For` como IP. Restringir además el ingress
  del origen a las IPs de Cloudflare (defensa en profundidad).
- Endpoints que leen body: usar `readBodyLimited`/`readJsonLimited`
  (`src/lib/body.ts`), no `request.json()` a pelo (el guard global del
  middleware solo mira el `Content-Length` declarado, que es salteable).

### Pendiente (follow-up)

La `cap_session` se ata solo a IP, no a `voter_id`; y `voter_id` es opcional,
así que quien no manda la cookie cae al cap solo-por-IP. Atar la sesión a
`voter_id` y exigirlo endurecería esto, pero dejaría afuera a usuarios con
cookies bloqueadas: decidir el trade-off de UX antes de implementarlo.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
