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
-- Acá el `select ... for update` toma el row lock ANTES de decidir el valor
-- nuevo, entonces el read-modify-write pasa entero adentro de una sola
-- transacción y la segunda invocación concurrente espera y ve el valor ya
-- incrementado. El `|| jsonb_build_object(...)` hace merge: NO pisa las otras
-- claves de `extra`.
--
-- Devuelve el valor YA incrementado, o null si el contacto no existe.
--
-- ── Expiración a las 24hs (agregado 2026-08-02, pedido de Santi: "que no
-- exista el resetear a mano") ──
-- Si pasaron más de 24hs desde la última pregunta fuera de tema
-- (`offtopic_updated_at`), el contador arranca de nuevo en 1 en vez de seguir
-- sumando. `leerOfftopicCount()` en `guardrail/index.ts` aplica la misma
-- regla del lado de LECTURA (por si pasan 24hs sin que llegue ningún mensaje
-- nuevo que dispare un bump — la primera lectura después de la ventana ya
-- tiene que ver 0, no esperar a la próxima escritura).

create or replace function public.bump_offtopic_count(_contact_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  _extra         jsonb;
  _last_updated  timestamptz;
  _current       integer;
  _new           integer;
begin
  select extra,
         (extra ->> 'offtopic_updated_at')::timestamptz,
         coalesce((extra ->> 'offtopic_count')::integer, 0)
    into _extra, _last_updated, _current
    from public.contacts
   where id = _contact_id
     for update;

  if not found then
    return null;
  end if;

  if _last_updated is null or _last_updated < now() - interval '24 hours' then
    _new := 1;
  else
    _new := _current + 1;
  end if;

  update public.contacts
     set extra = coalesce(_extra, '{}'::jsonb)
               || jsonb_build_object(
                    'offtopic_count', _new,
                    'offtopic_updated_at', now()
                  ),
         updated_at = now()
   where id = _contact_id;

  return _new;
end;
$$;

comment on function public.bump_offtopic_count(uuid) is
  'Incrementa atómicamente contacts.extra.offtopic_count y devuelve el valor nuevo (arranca de nuevo en 1 si pasaron más de 24hs desde offtopic_updated_at). Usado por agent-client cuando el bot gasta el "pase gratis" (saludo_generico aprobado) o cuando manda un recordatorio de alcance (fuera_de_tema).';

grant execute on function public.bump_offtopic_count(uuid) to service_role;

-- ============================================================
-- 3. Memoria de contacto — email y nombre completo detectados
-- ============================================================
--
-- Agregado 2026-08-05 junto con la memoria de corto plazo del guardrail
-- (ver proyectos/P05_plan_memoria_agente.md en consultorio_dermatologico).
-- Mismo patrón que bump_offtopic_count(): vive en contacts.extra (jsonb),
-- mismo campo que ya usa offtopic_count. Claves nuevas: `email`,
-- `nombre_completo`.
--
-- A diferencia de bump_offtopic_count(), acá no hace falta leer el valor
-- anterior para decidir el nuevo (no hay lógica de incremento ni de
-- expiración): el redactor ya decide el valor final a guardar (lo que la
-- paciente escribió en el mensaje), así que un UPDATE de una sola sentencia
-- que mergea el patch sobre extra alcanza — Postgres serializa dos UPDATE
-- concurrentes sobre la misma fila sin necesidad de un `select ... for
-- update` explícito (a diferencia del contador, acá no hay una decisión que
-- dependa del valor anterior).
--
-- Devuelve void. No falla si el contacto no existe (0 filas afectadas).

create or replace function public.merge_contact_datos_contacto(_contact_id uuid, _datos jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.contacts
     set extra = coalesce(extra, '{}'::jsonb) || _datos,
         updated_at = now()
   where id = _contact_id;
end;
$$;

comment on function public.merge_contact_datos_contacto(uuid, jsonb) is
  'Mergea datos de contacto detectados por el redactor (email, nombre_completo) en contacts.extra, sin pisar otras claves. Usado por agent-client cuando el redactor devuelve datos_detectados no vacío.';

grant execute on function public.merge_contact_datos_contacto(uuid, jsonb) to service_role;

-- ============================================================
-- 4. Migración 2026-08-06 — tipo "gestion_turno" + log de acciones de turnos
-- ============================================================
--
-- Ver proyectos/P05_plan_tools_turnos.md (repo consultorio_dermatologico)
-- para el diseño completo. Dos piezas:
--   4a. Agregar 'gestion_turno' al CHECK de tipo_declarado — si se omite,
--       registrarNoEnviada() falla en silencio para cualquier mensaje de
--       turnos que el juez rechace (ver el comentario de PROMPT_VERSION en
--       prompts.ts sobre por qué el CHECK y el enum de TS tienen que ir
--       sincronizados).
--   4b. Tabla turno_acciones — log + IDEMPOTENCIA de acciones reales sobre
--       Calendly (hoy solo agendar_turno; cancelar_turno no se expone al
--       modelo, ver sección 2.3 del plan). Es la primera vez que el agente
--       de IA ejecuta una acción real (no solo redacta texto), así que este
--       log cumple una función de seguridad, no solo de auditoría:
--       - El unique index en (incoming_message_id, tool) es lo que evita un
--         doble agendado si la Edge Function se reinvoca para el mismo
--         mensaje entrante (ver riesgo #4 del plan). Se inserta la fila
--         ANTES de llamar a Calendly; si la inserción viola el índice, ya se
--         intentó, no se ejecuta de nuevo.
--       - 'bloqueado' es un estado propio (no 'error'): significa que el
--         gate de código de guardrail/turnos.ts decidió NO ejecutar la
--         acción (ej. faltaba evidencia de que la paciente confirmó fecha/
--         hora) — se distingue de 'error' (Calendly falló) para que la
--         revisión humana sepa si el problema fue nuestro o de la API.

alter table public.agent_respuestas_no_enviadas
  drop constraint if exists agent_respuestas_no_enviadas_tipo_declarado_check;

alter table public.agent_respuestas_no_enviadas
  add constraint agent_respuestas_no_enviadas_tipo_declarado_check
  check (tipo_declarado in ('catalogo', 'pedir_precision', 'faq', 'agendar', 'gestion_turno', 'seguimiento_tratamiento', 'saludo_generico', 'fuera_de_tema', 'silencio'));

create table if not exists public.turno_acciones (
  id                   bigint generated always as identity primary key,
  organization_id      uuid not null references public.organizations (id) on delete cascade,
  conversation_id      text,          -- referencia suelta, sin FK, mismo criterio
                                      -- que agent_respuestas_no_enviadas.conversation_id
  contact_address      text,          -- E.164 sin '+'
  incoming_message_id  text not null,  -- id del mensaje entrante que disparó la acción
  tool                 text not null check (tool in ('agendar_turno')),
  args                 jsonb not null,
  resultado            jsonb,          -- lo que devolvió la tool (o el error)
  estado               text not null
    check (estado in ('intentado', 'ok', 'error', 'bloqueado')),
  created_at           timestamptz not null default now()
);

-- Idempotencia: como mucho un intento real por (mensaje entrante, tool).
create unique index if not exists turno_acciones_incoming_message_tool_idx
  on public.turno_acciones (incoming_message_id, tool);

create index if not exists turno_acciones_org_fecha_idx
  on public.turno_acciones (organization_id, created_at desc);

comment on table public.turno_acciones is
  'Log + idempotencia de acciones reales del agente de IA sobre Calendly (agendar_turno). El unique index en (incoming_message_id, tool) evita un doble agendado si la Edge Function se reinvoca para el mismo mensaje. estado=bloqueado = el gate de código decidió no ejecutar; estado=error = Calendly falló; ambos son motivo de revisión humana, no solo estado=ok con juez rechazado.';

-- Mismo criterio de RLS que agent_respuestas_no_enviadas: sin habilitar, solo
-- escribe la Edge Function con el service role key.

-- ============================================================
-- 5. Migración 2026-08-08 (v16) — rediseño del guardrail
-- ============================================================
--
-- Ver proyectos/P05_plan_rediseno_guardrail.md (repo consultorio_dermatologico)
-- y el changelog de PROMPT_VERSION v16 en guardrail/prompts.ts. Tres piezas:
--   5a. Se RETIRA el contador de fuera de tema.
--   5b. Tabla nueva agent_llm_calls — observabilidad de costo.
--   5c. Claves nuevas en contacts.extra (etapa, agendamiento_estado) — no
--       necesitan DDL, pero se documentan acá.

-- ── 5a. Retiro del contador de fuera de tema ──
--
-- El escalón "después de N preguntas fuera de tema, silencio" se elimina por
-- completo: ahora TODO mensaje fuera de tema recibe siempre la misma
-- respuesta corta y cordial. Ya nada llama a bump_offtopic_count().
--
-- Se DROPEA la función (no se usa más, y dejarla invita a que alguien la
-- vuelva a llamar sin querer). NO se toca `contacts.extra.offtopic_count` ni
-- `offtopic_updated_at`: son claves de un jsonb, quedan como dato histórico
-- inerte y limpiarlas no aporta nada. Tampoco se dropea la columna
-- `agent_respuestas_no_enviadas.offtopic_count` — desde v16 se escribe NULL,
-- pero las filas viejas conservan el valor que tenían al momento de decidir.
--
-- El CHECK de tipo_declarado se deja TAL CUAL, con 'fuera_de_tema' adentro,
-- aunque el tipo ya no exista en TypeScript: es un superset a propósito. Si
-- se sacara, el ALTER fallaría al validar las filas históricas que sí lo
-- tienen. El test `prompts_test.ts` verifica que TIPOS_RESPUESTA esté
-- CONTENIDO en el CHECK (no que sean iguales) justamente por esto.

drop function if exists public.bump_offtopic_count(uuid);

-- ── 5b. Observabilidad de costo ──
--
-- Un insert por cada llamado real a Claude, en cualquiera de los pasos del
-- pipeline. Escribe `guardrail/costos.ts`, siempre best-effort: si este
-- insert falla, la paciente igual recibe su respuesta (es auditoría de
-- costo, no un gate de seguridad como turno_acciones).
--
-- Sin dashboard todavía: primero que el dato exista y se pueda consultar por
-- SQL directo. Ver las consultas de ejemplo al final del archivo.

create table if not exists public.agent_llm_calls (
  id                    bigint generated always as identity primary key,
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  conversation_id       text,          -- referencia suelta, sin FK, mismo criterio
                                       -- que agent_respuestas_no_enviadas
  step                  text not null
    check (step in ('etapa', 'redactor', 'juez', 'reescritura', 'turnos')),
  model                 text not null,
  input_tokens          integer not null default 0,
  output_tokens         integer not null default 0,
  cached_tokens         integer not null default 0,  -- cache_read_input_tokens
  cache_creation_tokens integer not null default 0,  -- cache_creation_input_tokens
  cost_estimate         numeric(12, 8),              -- USD; null si el modelo no
                                                     -- está tarifado en costos.ts
  latency_ms            integer,
  created_at            timestamptz not null default now()
);

create index if not exists agent_llm_calls_org_fecha_idx
  on public.agent_llm_calls (organization_id, created_at desc);

create index if not exists agent_llm_calls_conversation_idx
  on public.agent_llm_calls (conversation_id, created_at desc);

comment on table public.agent_llm_calls is
  'Un registro por llamado real a Claude del guardrail (etapa/redactor/juez/reescritura/turnos), con tokens, costo estimado en USD y latencia. Insert best-effort desde guardrail/costos.ts: si falla, la respuesta a la paciente NO se bloquea. cost_estimate se guarda ya calculado a propósito — si cambian los precios, las filas viejas siguen reflejando lo que se pagó, y los tokens crudos permiten recalcular.';

-- Mismo criterio de RLS que las otras tablas de este archivo: sin habilitar,
-- solo escribe la Edge Function con el service role key.

-- ── 5c. Claves nuevas en contacts.extra (sin DDL) ──
--
-- Se suman dos claves al mismo jsonb que ya usan email/nombre_completo, y se
-- escriben con la MISMA función merge_contact_datos_contacto() — no hizo
-- falta un RPC nuevo, porque mergea un patch arbitrario sin pisar el resto:
--   · `etapa`                → 'explorando' | 'quiere_agendar' | 'agendando' |
--                              'agendado'  (guardrail/etapa.ts)
--   · `agendamiento_estado`  → 'recolectando_horario' | 'confirmando_datos' |
--                              'lista_para_agendar' | 'agendado'
--                              (guardrail/turnos.ts)
-- `agendamiento_estado` es lo que decide, EN CÓDIGO, si la tool de escritura
-- `agendar_turno` se le expone o no al modelo en ese mensaje.

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
--
-- Acciones de turnos que necesitan revisión humana (bloqueadas o con error):
--   select created_at, contact_address, tool, args, resultado, estado
--     from public.turno_acciones
--    where estado in ('bloqueado', 'error')
--    order by created_at desc;
--
-- ── v16: costo del agente (agent_llm_calls) ──
--
-- Cuánto costó el bot en los últimos 7 días, por paso del pipeline:
--   select step,
--          count(*)                as llamados,
--          sum(input_tokens)       as input,
--          sum(output_tokens)      as output,
--          sum(cached_tokens)      as leidos_de_cache,
--          round(sum(cost_estimate), 4) as usd,
--          round(avg(latency_ms))  as latencia_ms_promedio
--     from public.agent_llm_calls
--    where created_at > now() - interval '7 days'
--    group by 1
--    order by usd desc nulls last;
--
-- Costo por conversación (para encontrar las que se van de escala):
--   select conversation_id,
--          count(*) as llamados,
--          round(sum(cost_estimate), 4) as usd
--     from public.agent_llm_calls
--    where created_at > now() - interval '7 days'
--    group by 1
--    order by usd desc nulls last
--    limit 20;
--
-- ¿Está sirviendo el prompt caching? (cached_tokens debería dominar sobre
-- input_tokens en régimen; si no, algo está invalidando el prefijo):
--   select step,
--          sum(cached_tokens) as de_cache,
--          sum(input_tokens)  as sin_cache
--     from public.agent_llm_calls
--    where created_at > now() - interval '1 day'
--    group by 1;
--
-- Frecuencia del "rechazado 2 veces" — la métrica que dice si el juez sigue
-- demasiado rígido (ver P05_plan_rediseno_guardrail.md, sección 2):
--   select date_trunc('day', created_at) as dia, count(*)
--     from public.agent_respuestas_no_enviadas
--    where motivo like 'rechazado 2 veces%'
--    group by 1
--    order by 1 desc;
