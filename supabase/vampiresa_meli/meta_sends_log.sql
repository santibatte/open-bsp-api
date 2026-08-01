-- Historial de envíos de WhatsApp/Meta del consultorio (Vampiresa Meli).
--
-- NO es una migración del schema core de open-bsp-api (no se autogenera con
-- `supabase db diff`, no se aplica vía CI) — es específico de este negocio,
-- mismo patrón que setup.sql. Se corrió una sola vez a mano (2026-07-27) vía
-- la Management API.
--
-- Por qué existe: Meta no permite consultar el historial de mensajes
-- enviados después del hecho. `consultorio_dermatologico/scripts/lib/
-- meta_send_log.py` escribe acá (y en paralelo en
-- data/envios_meta/<fecha>/envios_<fecha>.csv, ver [[feedback-historial-envios-meta]])
-- cada vez que manda algo por Meta — esta tabla es la copia consultable
-- desde Postgres/Supabase.

create table if not exists public.vampiresa_meta_sends_log (
  id bigint generated always as identity primary key,
  fecha date not null,
  hora time not null,
  id_paciente text,
  nombre_persona text not null,
  numero_telefono text not null,
  template_nombre text not null,
  template_id text,
  variable_1_enviada text,
  variable_revisada_humano boolean not null,
  motivo_envio text,
  meta_message_id text,
  meta_status_respuesta text,
  enviado_por text,
  es_prueba boolean not null default false,
  notas text,
  created_at timestamptz not null default now()
);

create index if not exists vampiresa_meta_sends_log_telefono_idx
  on public.vampiresa_meta_sends_log (numero_telefono, fecha desc);
