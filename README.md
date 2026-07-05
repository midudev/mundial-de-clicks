# 🏆 Mundial de Clicks

Web en tiempo real donde apoyas a tu selección haciendo clicks. Cada click
es un voto, el ranking se sincroniza para todo el mundo al instante y la
infraestructura está pensada para **aguantar que Internet intente tumbarla**.

Construida con **Astro (SSR)**, **DragonFly** como base de datos de votos y
**Umami** para analytics. Pensada para desplegarse en **Coolify** sobre un VPS.

---

## 🧠 Cómo funciona (la parte interesante)

El truco para aguantar muchísimos clicks es **no escribir una fila por voto**:

```
Usuario hace click
       ↓
API valida el país
       ↓
Rate limit por IP (en DragonFly, atómico)   ← protección anti-abuso
       ↓
DragonFly: ZINCRBY / INCR (contadores atómicos en memoria)
       ↓
Un único bucle lee el estado cada 1s y lo cachea en memoria
       ↓
SSE empuja el snapshot a todos los espectadores
       ↓
DragonFly guarda un snapshot a disco cada 5 min (persistencia)
```

Puntos clave:

- **Contadores atómicos** (`ZINCRBY`, `INCR`): sin filas por click, sin bloqueos.
- **Rate limit por IP** con ventana fija en DragonFly: O(1) y auto-expirable.
- **Un solo poller** lee la base de datos: la carga **no** crece con el número
  de espectadores. Da igual 1 que 10.000 mirando el ranking.
- **Persistencia por snapshots**: si el server reinicia, como mucho se pierden
  unos minutos de votos. Para un mundial de clicks es más que suficiente.

---

## 🚀 Levantarlo en local

Necesitas **Node ≥ 22**, **pnpm** y **Docker**.

```sh
# 1. Dependencias
pnpm install

# 2. Infraestructura (DragonFly + Umami + Postgres)
docker compose up -d

# 3. App en modo desarrollo
pnpm dev
```

Abre `http://localhost:4321`. **No necesitas configurar variables**: los
valores por defecto ya apuntan a DragonFly en `localhost:6379`.

> Si solo quieres la app sin analytics: `docker compose up -d dragonfly`.

### Servicios locales

| Servicio  | URL                     | Notas                          |
| :-------- | :---------------------- | :----------------------------- |
| App       | http://localhost:4321   | La web del mundial             |
| Umami     | http://localhost:3001   | Analytics (login `admin`/`umami`) |
| DragonFly | `localhost:6379`        | Protocolo Redis                |

---

## 🗂️ Estructura

```
src/
├── lib/                  # Lógica de negocio (TypeScript, sin framework)
│   ├── types.ts          # Tipos compartidos
│   ├── config.ts         # Configuración por variables de entorno
│   ├── countries.ts      # Catálogo de selecciones
│   ├── redis.ts          # Cliente singleton de DragonFly
│   ├── rate-limit.ts     # Rate limiting por IP
│   ├── votes.ts          # Operaciones de voto sobre DragonFly
│   └── world-state.ts    # Estado en memoria + detección de eventos
├── pages/
│   ├── index.astro       # Página principal (SSR)
│   └── api/
│       ├── vote.ts       # POST /api/vote
│       ├── ranking.ts    # GET  /api/ranking
│       └── stream.ts     # GET  /api/stream (SSE)
├── components/           # UI en componentes Astro
├── scripts/              # Cliente TypeScript (votos + SSE + DOM)
└── styles/global.css     # Tailwind v4 + Geist Pixel
```

---

## ☁️ Desplegar en Coolify

La idea del proyecto: en Coolify se monta con **tres piezas** conectadas por
variables de entorno, sin tocar el código.

### 1. Base de datos DragonFly

En Coolify: **+ New → Database → DragonFly**. Anota el nombre interno del
servicio (p.ej. `dragonfly`).

### 2. La app (este repositorio)

**+ New → Public Repository**, pega la URL del repo. Coolify detecta el
`Dockerfile`/Node. Define estas variables de entorno:

| Variable       | Valor de ejemplo            | Obligatoria |
| :------------- | :-------------------------- | :---------- |
| `REDIS_URL`    | `redis://dragonfly:6379`    | ✅ Sí       |
| `HOST`         | `0.0.0.0`                   | ✅ Sí       |
| `PORT`         | `4321`                      | Recomendada |
| `RATE_LIMIT_MAX` | `15`                      | No          |
| `RATE_LIMIT_WINDOW` | `1`                    | No          |
| `STREAM_INTERVAL_MS` | `1000`                | No          |

### 3. Umami (analytics)

**+ New → Service → Umami** (plantilla one-click). Cuando esté arrancado,
crea el sitio web y copia su *Website ID* y la URL del script. Añádelos a la
app como variables **públicas** para que se inyecte el tracking:

| Variable                  | Valor de ejemplo                          |
| :------------------------ | :---------------------------------------- |
| `PUBLIC_UMAMI_SCRIPT_URL` | `https://umami.tudominio.com/script.js`   |
| `PUBLIC_UMAMI_WEBSITE_ID` | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`     |

> Las variables `PUBLIC_*` se leen en tiempo de build, así que si las cambias
> hay que **redesplegar** la app.

---

## 🧞 Comandos

| Comando        | Acción                                        |
| :------------- | :-------------------------------------------- |
| `pnpm dev`     | Servidor de desarrollo en `localhost:4321`    |
| `pnpm build`   | Build de producción en `./dist/`              |
| `pnpm preview` | Sirve el build de producción en local         |
| `pnpm astro check` | Comprobación de tipos                     |

---

## ⚙️ Variables de entorno

Todas son opcionales en local (hay valores por defecto). Ver `.env.example`
para la lista completa comentada.
