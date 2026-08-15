-- Campañas de WhatsApp/Meta programadas del consultorio (Vampiresa Meli).
--
-- NO es una migración del schema core de open-bsp-api (mismo patrón que
-- meta_sends_log.sql y setup.sql) — específico de este negocio, corrido a
-- mano vía la Management API.
--
-- Por qué existe: hasta acá, toda campaña (IPL, pedido de adelanto, etc.) se
-- mandaba en una sesión en vivo con Claude corriendo un script local. Esto
-- permite dejar una campaña ARMADA (template + lista de destinatarios ya
-- resuelta) con una fecha de envío, y que el cron de Vercel
-- (recordatorios-cron/api/campana.py) la dispare solo ese día — sin depender
-- de que la compu de Santi esté prendida. Ver [[project-campanas-programadas]].
--
-- Quién la puebla: scripts/lib/campanas.py (programar_campana()), corrido a
-- mano por Claude/Santi el día que arman la campaña — la resolución de
-- teléfono/variables sigue necesitando ojo humano, lo que se automatiza es
-- el DISPARO en la fecha elegida, no el armado de la lista.

create table if not exists public.vampiresa_campanas (
  id bigint generated always as identity primary key,
  nombre text not null,
  template_nombre text not null,
  template_id text,
  idioma text not null default 'es_AR',
  motivo_envio text not null,
  programada_para date not null,
  estado text not null default 'scheduled'
    check (estado in ('scheduled', 'sent', 'paused', 'cancelled')),
  creado_por text,
  notas text,
  created_at timestamptz not null default now()
);

create table if not exists public.vampiresa_campana_destinatarios (
  id bigint generated always as identity primary key,
  campana_id bigint not null references public.vampiresa_campanas (id),
  id_paciente text,
  nombre_persona text not null,
  numero_telefono text not null,
  variables jsonb not null default '[]'::jsonb,
  variable_revisada_humano boolean not null,
  es_prueba boolean not null default false,
  estado text not null default 'pending'
    check (estado in ('pending', 'sent', 'failed', 'skipped')),
  meta_message_id text,
  meta_status_respuesta text,
  procesado_at timestamptz,
  notas text,
  created_at timestamptz not null default now(),
  unique (campana_id, numero_telefono)
);

create index if not exists vampiresa_campanas_pendientes_idx
  on public.vampiresa_campanas (programada_para)
  where estado = 'scheduled';

create index if not exists vampiresa_campana_destinatarios_pendientes_idx
  on public.vampiresa_campana_destinatarios (campana_id, estado)
  where estado = 'pending';

-- RLS: sin policies (solo lo toca el service role desde el cron, o el SQL
-- editor / Management API a mano) — mismo motivo y mismo patrón que
-- meta_sends_log.sql: en Supabase, `public` sin RLS es legible/editable por
-- cualquiera con la API key pública del proyecto.
alter table public.vampiresa_campanas enable row level security;
alter table public.vampiresa_campana_destinatarios enable row level security;
