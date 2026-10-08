# ⚖️ Panel de jueces

Plataforma web para calificar proyectos en eventos con varios jueces. Corre en **Cloudflare Pages** (gratis):
la página es estática y todos los datos pasan por una API propia en el servidor (Pages Functions + base de datos D1).
**El navegador nunca recibe claves ni acceso directo a la base de datos.**

- **Organizador** (`/`): entra con contraseña, crea eventos, define criterios y pesos, agrega jueces y obtiene ranking, puntajes y feedback.
- **Jueces** (`/judge?t=…`): cada uno recibe un enlace único. Ve los proyectos del evento, **puede agregar proyectos nuevos** y califica cada criterio, con feedback para el equipo y una nota privada opcional para el organizador.
- **Resultados**: ranking 0–100, promedio por criterio, matriz jueces × proyectos y detalle completo. Exporta a CSV.
- **Feedback para participantes**: comentarios por proyecto **sin puntajes ni notas privadas**. Se descarga en .md o CSV, o se imprime/guarda como PDF (una página por proyecto).

## Estructura
```
public/                     página estática (lo único que se publica como archivos)
functions/api/[[path]].js   API: sesión del organizador, validación y acceso a D1
migrations/                 esquema de la base de datos
wrangler.toml               configuración de Cloudflare
```

## Publicar (una sola vez)

Necesitas Node.js 18 o superior y una cuenta gratuita de Cloudflare.

```bash
npm install
npx wrangler login                      # abre el navegador para autorizar
npx wrangler d1 create jueces           # crea la base de datos
```
Copia el `database_id` que imprime el último comando y pégalo en [`wrangler.toml`](wrangler.toml). Después:

```bash
npm run db:migrate:remote               # crea las tablas en Cloudflare
```

### Opción A: publicar automáticamente desde GitHub (recomendada)
1. Sube el repo a GitHub (puede ser privado):
   ```bash
   git init && git add . && git commit -m "Panel de jueces"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/jueces.git
   git push -u origin main
   ```
2. En Cloudflare: **Workers & Pages → Create → Pages → Connect to Git** y elige el repo.
   - Framework preset: *None*
   - Build command: *(vacío)*
   - Build output directory: `public`
3. Antes o después del primer deploy, en el proyecto: **Settings → Variables and Secrets → Add** (tipo *Secret*, entorno *Production*):
   - `ADMIN_PASSWORD`: tu contraseña de organizador (larga, por ejemplo 4 o 5 palabras).
   - `SESSION_SECRET`: el resultado de `openssl rand -hex 32`.
4. **Deployments → Retry deployment** (o haz un push) para que tome los secrets.

Desde entonces, cada `git push` publica la nueva versión. La URL será `https://jueces.pages.dev` (o el nombre que elijas).

### Opción B: publicar desde tu computadora
```bash
npx wrangler pages project create jueces --production-branch main
npx wrangler pages secret put ADMIN_PASSWORD --project-name jueces
npx wrangler pages secret put SESSION_SECRET --project-name jueces
npm run deploy
```

## Probar localmente
```bash
cp .dev.vars.example .dev.vars          # y edita la contraseña y el secreto
npm run db:migrate:local
npm run dev                             # abre http://localhost:8788
```

## Uso
1. Entra a la URL, escribe tu contraseña y crea un evento.
2. En **Configuración** ajusta criterios, pesos y escala (por defecto 0–10).
3. En **Jueces** agrega a cada juez y mándale su enlace (botón **Copiar**).
4. Carga los proyectos en **Proyectos** o deja que los jueces los agreguen. Si un juez intenta crear uno con un nombre existente, se le ofrece calificar ese.
5. Sigue el avance en **Resultados** (botón **↻ Actualizar**).
6. Al terminar, pulsa **Cerrar evento**: los jueces ya no pueden editar.
7. Descarga el ranking y el detalle (CSV) y entrega el feedback desde **Feedback**.

**Cálculo**: para cada juez, `total = Σ(nota ÷ máximo × peso) ÷ Σ pesos × 100`. El puntaje del proyecto es el promedio de los jueces que lo calificaron; los empates comparten posición.

## Seguridad
- **Sin claves en el navegador.** La base de datos solo es accesible desde la API del servidor. La contraseña y el secreto de sesión son *secrets* de Cloudflare y no están en el repo.
- **Organizador**: la sesión es una cookie `HttpOnly`, `Secure` y `SameSite=Strict`, firmada con HMAC y válida por 12 horas. Tras 10 contraseñas incorrectas en 15 minutos, esa IP queda bloqueada por 15 minutos.
- **Jueces**: el enlace lleva un token aleatorio de 144 bits. El servidor valida cada acción: el juez solo ve proyectos de su evento y sus propias calificaciones, no puede calificar con el evento cerrado, y los puntajes deben estar en rango. Quien tenga el enlace puede calificar como ese juez, así que compártelo solo con esa persona. Si se filtra, elimina al juez (el enlace deja de funcionar) y crea otro.
- **Protección del navegador**: headers CSP estrictos, sin iframes, `Referrer-Policy: no-referrer` (el token del juez no se filtra a otros sitios) y protección CSRF (solo JSON del mismo origen).
