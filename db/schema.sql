-- ============================================================
-- QUILLTOOT — Schema de base de datos (PostgreSQL / Supabase)
-- ============================================================
-- Diseñado para:
--  - Servir la API estilo Mastodon que Elk necesita para funcionar
--  - Federar vía ActivityPub (WebFinger, Actor, HTTP Signatures, Inbox/Outbox)
--
-- Notas de diseño:
--  - Los usuarios LOCALES viven en `users`. Los usuarios REMOTOS
--    (de otras instancias) se cachean en `remote_actors`.
--  - `statuses.author_id` siempre apunta a un `users` local.
--    Los posts que vienen de otras instancias por federación se
--    guardan en `remote_statuses`, separados, porque su forma de
--    identificarse (por URI global) es distinta a la de un post local.
--  - Los usuarios locales SOLO pueden publicar texto (sin adjuntos).
--    Los posts remotos SÍ pueden traer adjuntos (imágenes, etc.)
--    tal como vengan del servidor de origen — nosotros no los
--    procesamos, solo guardamos la URL y a metadata.
-- ============================================================

-- Extensión para generar UUIDs
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------
-- USERS (cuentas locales de esta instancia)
-- ------------------------------------------------------------
CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username            TEXT NOT NULL UNIQUE,        -- sin @ ni dominio, ej: "luciano"
    email               TEXT NOT NULL UNIQUE,
    password_hash       TEXT NOT NULL,                -- bcrypt

    display_name        TEXT,
    bio                 TEXT DEFAULT '',

    -- Par de claves RSA para HTTP Signatures (firmar actividades salientes
    -- y publicar la clave pública en el Actor para que otros nos verifiquen)
    private_key_pem     TEXT NOT NULL,
    public_key_pem       TEXT NOT NULL,

    -- Contadores desnormalizados para no calcularlos en cada request
    followers_count     INTEGER NOT NULL DEFAULT 0,
    following_count     INTEGER NOT NULL DEFAULT 0,
    statuses_count      INTEGER NOT NULL DEFAULT 0,

    -- La primera cuenta creada en la instancia se vuelve admin automáticamente.
    -- Un admin puede otorgar/quitar admin a otros después.
    is_admin             BOOLEAN NOT NULL DEFAULT false,

    -- Aprobación de admin (APPROVAL_REQUIRED, activado por defecto):
    -- una cuenta 'pending' no puede completar el login OAuth hasta que
    -- un admin la apruebe. La primera cuenta (admin) siempre nace 'approved'.
    approval_status      TEXT NOT NULL DEFAULT 'approved'
                            CHECK (approval_status IN ('pending', 'approved', 'rejected')),
    join_reason          TEXT,  -- por qué quiere unirse; obligatorio si APPROVAL_REQUIRED=true

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_approval_status ON users(approval_status) WHERE approval_status = 'pending';

-- ------------------------------------------------------------
-- REMOTE_ACTORS (cache de actores de otras instancias)
-- ------------------------------------------------------------
-- Cuando alguien de mastodon.social nos sigue o interactúa, guardamos
-- aquí su Actor para no tener que resolverlo por WebFinger cada vez.
CREATE TABLE remote_actors (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_uri           TEXT NOT NULL UNIQUE,   -- ej: https://mastodon.social/users/fulano
    username            TEXT NOT NULL,          -- "fulano"
    domain              TEXT NOT NULL,          -- "mastodon.social"
    display_name        TEXT,
    inbox_url           TEXT NOT NULL,
    shared_inbox_url    TEXT,                   -- si el servidor remoto soporta shared inbox
    public_key_pem      TEXT NOT NULL,          -- para verificar sus firmas

    raw_actor_json      JSONB,                  -- copia del objeto Actor completo, por si acaso

    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_remote_actors_domain ON remote_actors(domain);

-- ------------------------------------------------------------
-- STATUSES (posts de usuarios LOCALES — solo texto)
-- ------------------------------------------------------------
CREATE TABLE statuses (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    author_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    content             TEXT NOT NULL,           -- texto plano o HTML simple (b, i, a, br)
    content_warning     TEXT,                    -- spoiler_text de Mastodon (opcional)

    visibility          TEXT NOT NULL DEFAULT 'public'
                            CHECK (visibility IN ('public', 'unlisted', 'private', 'direct')),

    -- Para hilos/respuestas: puede apuntar a un status local.
    -- (La referencia a remote_statuses se agrega más abajo con ALTER TABLE,
    -- porque esa tabla todavía no existe en este punto del archivo.)
    in_reply_to_status_id  UUID REFERENCES statuses(id) ON DELETE SET NULL,
    in_reply_to_remote_id  UUID,

    -- URI pública de ActivityPub para este post: https://tudominio.com/statuses/<id>
    activity_uri        TEXT NOT NULL UNIQUE,

    federated           BOOLEAN NOT NULL DEFAULT false,  -- ya se mandó a los followers?

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_statuses_author ON statuses(author_id, created_at DESC);

-- ------------------------------------------------------------
-- REMOTE_STATUSES (posts federados que llegaron de otras instancias)
-- ------------------------------------------------------------
-- Estos SÍ pueden traer adjuntos (imágenes, video, etc.) porque
-- simplemente reflejamos lo que el servidor de origen nos mandó.
CREATE TABLE remote_statuses (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    author_actor_id     UUID NOT NULL REFERENCES remote_actors(id) ON DELETE CASCADE,

    activity_uri        TEXT NOT NULL UNIQUE,   -- el "id" original del objeto Note remoto
    content              TEXT NOT NULL,          -- HTML tal como vino (ya sanitizado)
    content_warning      TEXT,

    -- Adjuntos tal cual vinieron: [{ "url": "...", "type": "image/png", "description": "..." }, ...]
    attachments          JSONB NOT NULL DEFAULT '[]',

    visibility           TEXT NOT NULL DEFAULT 'public',
    in_reply_to_uri       TEXT,                  -- puede apuntar a cualquier URI, local o remota

    raw_object_json       JSONB,                 -- copia del objeto ActivityPub completo

    received_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_remote_statuses_author ON remote_statuses(author_actor_id, received_at DESC);

-- Ahora que remote_statuses ya existe, completamos la FK que dejamos pendiente en `statuses`
ALTER TABLE statuses
    ADD CONSTRAINT fk_statuses_in_reply_to_remote
    FOREIGN KEY (in_reply_to_remote_id) REFERENCES remote_statuses(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- FOLLOWS (relaciones de seguimiento — locales y/o remotas en cualquier combinación)
-- ------------------------------------------------------------
-- Un follow siempre tiene un lado local (el que vive en nuestra instancia)
-- y el otro lado puede ser local o remoto.
CREATE TABLE follows (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Quién sigue (siempre referenciamos con EXACTAMENTE uno de estos dos pares lleno)
    follower_user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    follower_actor_id   UUID REFERENCES remote_actors(id) ON DELETE CASCADE,

    -- A quién sigue
    followee_user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    followee_actor_id   UUID REFERENCES remote_actors(id) ON DELETE CASCADE,

    -- Estado: pendiente (si la cuenta es privada) o aceptado
    status              TEXT NOT NULL DEFAULT 'accepted'
                            CHECK (status IN ('pending', 'accepted')),

    -- URI de la actividad Follow original, para poder mandar Accept/Undo referenciándola
    follow_activity_uri TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (
        (follower_user_id IS NOT NULL)::int + (follower_actor_id IS NOT NULL)::int = 1
    ),
    CHECK (
        (followee_user_id IS NOT NULL)::int + (followee_actor_id IS NOT NULL)::int = 1
    )
);

-- Evita duplicados de follow (un usuario local siguiendo al mismo actor dos veces, etc.)
CREATE UNIQUE INDEX idx_follows_unique_local_to_user
    ON follows(follower_user_id, followee_user_id) WHERE follower_user_id IS NOT NULL AND followee_user_id IS NOT NULL;
CREATE UNIQUE INDEX idx_follows_unique_local_to_actor
    ON follows(follower_user_id, followee_actor_id) WHERE follower_user_id IS NOT NULL AND followee_actor_id IS NOT NULL;
CREATE UNIQUE INDEX idx_follows_unique_actor_to_local
    ON follows(follower_actor_id, followee_user_id) WHERE follower_actor_id IS NOT NULL AND followee_user_id IS NOT NULL;

-- ------------------------------------------------------------
-- FAVOURITES (likes) — sobre statuses locales o remotos
-- ------------------------------------------------------------
CREATE TABLE favourites (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    status_id           UUID REFERENCES statuses(id) ON DELETE CASCADE,
    remote_status_id    UUID REFERENCES remote_statuses(id) ON DELETE CASCADE,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (
        (status_id IS NOT NULL)::int + (remote_status_id IS NOT NULL)::int = 1
    )
);

CREATE UNIQUE INDEX idx_favourites_unique_local ON favourites(user_id, status_id) WHERE status_id IS NOT NULL;
CREATE UNIQUE INDEX idx_favourites_unique_remote ON favourites(user_id, remote_status_id) WHERE remote_status_id IS NOT NULL;

-- ------------------------------------------------------------
-- REBLOGS (boosts) — sobre statuses locales o remotos
-- ------------------------------------------------------------
CREATE TABLE reblogs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    status_id           UUID REFERENCES statuses(id) ON DELETE CASCADE,
    remote_status_id    UUID REFERENCES remote_statuses(id) ON DELETE CASCADE,

    activity_uri        TEXT NOT NULL UNIQUE,  -- URI de nuestra actividad Announce

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (
        (status_id IS NOT NULL)::int + (remote_status_id IS NOT NULL)::int = 1
    )
);

CREATE UNIQUE INDEX idx_reblogs_unique_local ON reblogs(user_id, status_id) WHERE status_id IS NOT NULL;
CREATE UNIQUE INDEX idx_reblogs_unique_remote ON reblogs(user_id, remote_status_id) WHERE remote_status_id IS NOT NULL;

-- ------------------------------------------------------------
-- OAUTH_APPS (apps cliente registradas, ej: Elk)
-- ------------------------------------------------------------
CREATE TABLE oauth_apps (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id           TEXT NOT NULL UNIQUE,
    client_secret       TEXT NOT NULL,

    name                TEXT NOT NULL,          -- "Elk"
    redirect_uris       TEXT NOT NULL,          -- puede ser una lista separada por saltos de línea
    scopes              TEXT NOT NULL DEFAULT 'read write follow',
    website             TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- OAUTH_TOKENS (tokens emitidos tras login exitoso)
-- ------------------------------------------------------------
CREATE TABLE oauth_tokens (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    access_token        TEXT NOT NULL UNIQUE,

    app_id              UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scopes              TEXT NOT NULL DEFAULT 'read write follow',

    -- Código de autorización temporal (antes de intercambiarlo por el token)
    -- lo guardamos en la misma tabla para simplicidad, con created_at corto
    revoked             BOOLEAN NOT NULL DEFAULT false,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_oauth_tokens_access_token ON oauth_tokens(access_token);

-- ------------------------------------------------------------
-- OAUTH_AUTH_CODES (códigos temporales del flujo OAuth, antes del token)
-- ------------------------------------------------------------
CREATE TABLE oauth_auth_codes (
    code                TEXT PRIMARY KEY,
    app_id              UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri        TEXT NOT NULL,
    scopes              TEXT NOT NULL DEFAULT 'read write follow',
    expires_at          TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes'),
    used                BOOLEAN NOT NULL DEFAULT false
);

-- ------------------------------------------------------------
-- INBOX_LOG (log simple de actividades recibidas, para debug y para
-- deduplicar actividades que el mismo servidor remoto reenvía)
-- ------------------------------------------------------------
CREATE TABLE inbox_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    activity_uri        TEXT NOT NULL UNIQUE,
    activity_type       TEXT NOT NULL,       -- "Follow", "Create", "Like", "Announce", "Undo", etc.
    actor_uri           TEXT NOT NULL,
    raw_json            JSONB NOT NULL,
    processed           BOOLEAN NOT NULL DEFAULT false,
    error               TEXT,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);