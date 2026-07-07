# Quilltoot

Quilltoot es un servidor ActivityPub (compatible con la API de Mastodon) pensado para ser simple: tan simple que no hace falta rentar un servidor ni pagar por hosting. Corre gratis en **Vercel** con **Supabase** como base de datos.

Es compatible con [Elk](https://elk.zone) como cliente — cualquiera puede loguearse ahí apuntando a tu instancia.

## Qué necesitás

- Una cuenta de [Supabase](https://supabase.com) (gratis)
- Una cuenta de [Vercel](https://vercel.com) (gratis)
- Un fork o clon de este repo en tu propia cuenta de GitHub
- Un dominio (puede ser el que te da Vercel gratis, tipo `tu-proyecto.vercel.app`)

No hace falta Node instalado en tu máquina a menos que quieras probarlo localmente antes de deployar.

## 1. Crear la base de datos en Supabase

1. Andá a [supabase.com](https://supabase.com) → **New project**.
2. Elegí una contraseña para la base (guardala, la vas a necesitar).
3. Una vez creado el proyecto, andá a **SQL Editor** → **New query**.
4. Copiá todo el contenido de [`db/schema.sql`](./db/schema.sql) de este repo, pegalo ahí, y ejecutalo (▶ Run). Esto crea todas las tablas, incluido el módulo de moderación.
5. Andá a **Project Settings → Database → Connection string**. Elegí el modo **Transaction** (puerto `6543`, el pooler de Supabase — importante para serverless, ya que cada invocación de Vercel abre su propia conexión y sin pooler se agotan rápido).
6. Copiá esa connection string completa (con la contraseña ya puesta, o reemplazá `[YOUR-PASSWORD]` por la tuya). Este valor va a ser tu `DATABASE_URL`.

## 2. Deployar en Vercel

1. Andá a [vercel.com/new](https://vercel.com/new) e importá tu fork de este repo.
2. Antes de darle a Deploy, configurá las **Environment Variables** (Vercel te las pide en esa misma pantalla, o después en Project Settings → Environment Variables):

   | Variable | Valor | Notas |
   |---|---|---|
   | `DATABASE_URL` | la connection string de Supabase del paso anterior | **obligatoria** |
   | `INSTANCE_DOMAIN` | tu dominio, sin `https://` ni barra final (ej: `tu-proyecto.vercel.app`) | **obligatoria**. Ver advertencia abajo |
   | `OPEN_REGISTRATION` | `false` (recomendado) o `true` | si es `false`, solo un admin logueado puede crear cuentas nuevas |
   | `APPROVAL_REQUIRED` | `true` (default si no la ponés) o `false` | si es `true`, las cuentas nuevas quedan pendientes hasta que un admin las apruebe |

   ⚠️ **`INSTANCE_DOMAIN` hay que fijarlo *antes* del primer deploy y no cambiarlo después.** Se usa para construir las URIs de ActivityPub (Actor, WebFinger, posts). Cambiarlo una vez que la instancia ya federó con otros servidores rompe esas referencias.

3. Deploy. Vercel va a detectar `vercel.json` y montar la función serverless en `api/index.js`, que expone toda la app (Express) tal cual corre localmente.

## 3. Crear tu cuenta (te convertís en admin automáticamente)

**La primera cuenta que se registra en la instancia se vuelve admin sola** — no hace falta tocar la base de datos a mano.

Con la instancia ya deployada, registrate pegándole al endpoint (con `curl`, Postman, o Insomnia — no hay UI propia de registro, para eso está Elk, ver paso 4):

```bash
curl -X POST https://tu-proyecto.vercel.app/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "tu_usuario",
    "email": "vos@ejemplo.com",
    "password": "una-contraseña-segura",
    "display_name": "Tu Nombre"
  }'
```

Como sos la primera cuenta, quedás `approved` y con `is_admin: true` de una, sin importar qué diga `APPROVAL_REQUIRED`.

## 4. Conectar Elk como cliente

Andá a [elk.zone](https://elk.zone) → **Sign in** → en el campo de instancia, poné tu dominio (`tu-proyecto.vercel.app`, sin `https://`) → iniciá sesión con el usuario y contraseña que acabás de crear.

Desde ahí ya podés postear, seguir gente, y (si sos admin/moderador) usar el panel de moderación que expone `routes/moderation.js`.

## Correrlo localmente (opcional, para desarrollo)

```bash
git clone https://github.com/Lucianopm24/Quilltoot.git
cd Quilltoot
npm install
cp .env.example .env
# editá .env con tu DATABASE_URL de Supabase y tu INSTANCE_DOMAIN
npm start
```

Esto levanta el server en `http://localhost:3000` (o el `PORT` que hayas puesto). Para desarrollo local podés usar el mismo Supabase que en producción, o crear otro proyecto aparte — el schema es el mismo.

## Estructura del proyecto

```
quilltoot/
├── api/
│   └── index.js          # entry point serverless (reexporta index.js para Vercel)
├── db/
│   ├── schema.sql        # todo el schema de Postgres/Supabase
│   └── pool.js           # conexión a la base (pg)
├── lib/                  # helpers: auth, federación, moderación, firmas HTTP, etc.
├── routes/                # endpoints: auth, statuses, timelines, follows, moderación, reportes...
├── index.js               # server Express (rutas + arranque)
├── vercel.json             # config de Vercel (rutea todo a api/index.js)
└── .env.example
```

## Notas y limitaciones conocidas

- **Sin adjuntos/medios para usuarios locales.** Los posts que llegan federados de otras instancias sí pueden traer imágenes, pero Quilltoot solo publica texto de tu lado.
- **Reportes de cuentas remotas quedan solo locales** — no se reenvían a la instancia de origen (Mastodon real lo hace opcionalmente).
- **La moderación no notifica al usuario afectado** — si te suspenden o silencian, es silencioso, no llega un aviso.
- **No hay "ocultar" un post individual** sin suspender o silenciar toda la cuenta.
- **Resolución de menciones** (`@usuario@instancia` en el texto de un post) todavía no está implementada — un mensaje que dependa de eso no federa correctamente.

## Troubleshooting rápido

- **"Falta la variable de entorno DATABASE_URL"** al abrir la función en Vercel → revisá que la variable esté puesta en el proyecto (Project Settings → Environment Variables) y que hayas hecho un redeploy después de agregarla.
- **Timeouts o "too many connections" en la base** → confirmá que estás usando la connection string del modo **Transaction/Pooler** de Supabase (puerto `6543`), no la de conexión directa (puerto `5432`).
- **Elk no puede loguearse** → confirmá que pusiste el dominio sin `https://` y sin barra final, y que `INSTANCE_DOMAIN` en Vercel coincide exactamente con ese dominio.