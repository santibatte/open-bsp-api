-- Guardrails del agente de IA — Consultorio de la Vampiresa Meli
--
-- NO es una migración del schema core de open-bsp-api (no se autogenera con
-- `supabase db diff`, no se aplica vía CI) — es específico de este negocio,
-- mismo patrón que setup.sql y meta_sends_log.sql. Se corre una sola vez a
-- mano en el SQL editor de Supabase (proyecto `velvet-agent`).
--
-- ✅ Ejecutado contra la base real (`velvet-agent`) el 2026-08-01. El bloque
-- 3 de más abajo ("faq") se agregó 2026-08-02 y ES una migración sobre una
-- tabla que ya existe — el `create table if not exists` de acá abajo no la
-- vuelve a tocar, por eso el ALTER está separado y es idempotente.
--
-- Contiene las dos piezas de estado que el patrón de dos llamados (redactor +
-- juez) necesita del lado de la base:
--   1. `public.agent_respuestas_no_enviadas` — log de todo lo que el bot
--      decidió NO mandar (rechazado por el juez, o silenciado por contador).
--   2. `public.bump_offtopic_count()` — incremento ATÓMICO del contador de
--      preguntas fuera de tema por contacto, en `contacts.extra`.

-- ============================================================
-- 1. Log de respuestas no enviadas
-- ============================================================
--
-- Para qué: que Santi y Meli revisen DESPUÉS y en bloque qué preguntas quedaron
-- sin responder, y con eso mejoren el catálogo y los prompts. NO dispara
-- ninguna acción automática — no escala a humano, no notifica. Decisión
-- explícita de Santi: "por ahora no hacemos nada más".

create table if not exists public.agent_respuestas_no_enviadas (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  contact_id       uuid references public.contacts (id) on delete set null,
  contact_address  text,          -- E.164 sin '+' (redundante con contact_id a
                                  -- propósito: el contacto puede no existir
                                  -- todavía, o borrarse después)
  conversation_id  text,          -- referencia suelta, sin FK, para no acoplar
                                  -- este log al ciclo de vida de conversations
  mensaje_paciente text not null,
  tipo_declarado   text not null
    check (tipo_declarado in ('catalogo', 'pedir_precision', 'faq', 'agendar', 'seguimiento_tratamiento', 'saludo_generico', 'fuera_de_tema', 'silencio')),
  mensaje_borrador text not null default '',  -- vacío cuando tipo = 'silencio'
  motivo           text not null,  -- el motivo que devolvió el juez, o
                                   -- 'silencio - contador >= 1' si no hubo juez
  offtopic_count   integer,        -- valor del contador AL MOMENTO de decidir
                                   -- (para poder auditar al juez después)
  created_at       timestamptz not null default now()
);

create index if not exists agent_respuestas_no_enviadas_org_fecha_idx
  on public.agent_respuestas_no_enviadas (organization_id, created_at desc);

create index if not exists agent_respuestas_no_enviadas_contacto_idx
  on public.agent_respuestas_no_enviadas (contact_address, created_at desc);

comment on table public.agent_respuestas_no_enviadas is
  'Respuestas que el agente de IA decidió NO enviar (rechazadas por el juez, o silenciadas por contador de fuera-de-tema). Solo para revisión humana posterior; no dispara nada automático.';

-- Nota sobre RLS: se deja SIN habilitar, igual que
-- public.vampiresa_meta_sends_log. Solo escribe la Edge Function con el
-- service role key (que igual bypassea RLS) y solo lee Santi desde el SQL
-- editor. Si en algún momento esta tabla se expone en la UI de open-bsp,
-- HAY que habilitar RLS y agregar una policy por organization_id.

-- ============================================================
-- 1b. Migración 2026-08-02 — agregar tipo "faq" al CHECK
-- ============================================================
--
-- La tabla de arriba ya existía en producción con el CHECK viejo (sin
-- 'faq'), así que el `create table if not exists` no alcanza para
-- actualizarla. Idempotente: correrlo de nuevo no rompe nada.

alter table public.agent_respuestas_no_enviadas
  drop constraint if exists agent_respuestas_no_enviadas_tipo_declarado_check;

alter table public.agent_respuestas_no_enviadas
  add constraint agent_respuestas_no_enviadas_tipo_declarado_check
  check (tipo_declarado in ('catalogo', 'pedir_precision', 'faq', 'saludo_generico', 'silencio'));

-- ============================================================
-- 1c. Migración 2026-08-02 (misma tarde) — agendar, seguimiento_tratamiento,
--     fuera_de_tema
-- ============================================================
--
-- Tres huecos reales encontrados probando en vivo con los 2 números de
-- prueba (ver prompts.ts para el detalle). También idempotente.

alter table public.agent_respuestas_no_enviadas
  drop constraint if exists agent_respuestas_no_enviadas_tipo_declarado_check;

alter table public.agent_respuestas_no_enviadas
  add constraint agent_respuestas_no_enviadas_tipo_declarado_check
  check (tipo_declarado in ('catalogo', 'pedir_precision', 'faq', 'agendar', 'seguimiento_tratamiento', 'saludo_generico', 'fuera_de_tema', 'silencio'));

-- ============================================================
-- 2. Contador atómico de preguntas fuera de tema
-- ============================================================
--
-- Vive en `contacts.extra` (jsonb), el mismo campo que ya usa la carga masiva
-- de 265 contactos para `id_paciente` / `origen` / `mail`. Clave nueva:
-- `offtopic_count`. Si no existe, cuenta como 0.
--
-- Por qué una función y no leer-modificar-escribir desde la Edge Function:
-- si llegan dos mensajes muy seguidos del mismo contacto, dos invocaciones
-- concurrentes de agent-client harían ambas `read 0 -> write 1` y el contador
-- quedaría en 1 en vez de 2 (el paciente se ganaría un "pase gratis" extra).
-- Acá el UPDATE toma el row lock, entonces el read-modify-write pasa entero
-- adentro de una sola sentencia y la segunda transacción ve el valor ya
-- incrementado. El `|| jsonb_build_object(...)` hace merge: NO pisa las otras
-- claves de `extra`.
--
-- Devuelve el valor YA incrementado, o null si el contacto no existe.

create or replace function public.bump_offtopic_count(_contact_id uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  update public.contacts
     set extra = coalesce(extra, '{}'::jsonb)
               || jsonb_build_object(
                    'offtopic_count',
                    coalesce((extra ->> 'offtopic_count')::integer, 0) + 1
                  ),
         updated_at = now()
   where id = _contact_id
  returning (extra ->> 'offtopic_count')::integer;
$$;

comment on function public.bump_offtopic_count(uuid) is
  'Incrementa atómicamente contacts.extra.offtopic_count y devuelve el valor nuevo. Usado por agent-client cuando el bot gasta el "pase gratis" (saludo_generico aprobado) o cuando silencia una repregunta fuera de tema.';

grant execute on function public.bump_offtopic_count(uuid) to service_role;

-- ============================================================
-- Consultas útiles para la revisión manual
-- ============================================================
--
-- Lo no enviado de la última semana, agrupado por tipo:
--   select tipo_declarado, count(*)
--     from public.agent_respuestas_no_enviadas
--    where created_at > now() - interval '7 days'
--    group by 1;
--
-- Las preguntas que el juez rechazó (candidatas a ampliar el catálogo):
--   select created_at, contact_address, mensaje_paciente, mensaje_borrador, motivo
--     from public.agent_respuestas_no_enviadas
--    where tipo_declarado = 'catalogo'
--    order by created_at desc;
--
-- Contactos que más insisten con temas que no cubrimos:
--   select c.name, c.extra ->> 'offtopic_count' as veces
--     from public.contacts c
--    where (c.extra ->> 'offtopic_count')::integer > 0
--    order by 2 desc;
