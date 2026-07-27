-- Setup SQL — Consultorio de la Vampiresa Meli, agente de WhatsApp/Instagram
--
-- NO es una migración (no se autogenera con `supabase db diff`, no se aplica
-- vía CI). Es un script de una sola vez para correr a mano en el SQL editor
-- de Supabase (o `npx supabase db execute` en local) una vez que exista un
-- proyecto Supabase real conectado al fork. Ver P05_HANDOFF.md §4.3 y el
-- README de OpenBSP, sección "WhatsApp integration" → "For any number you
-- add", que es el patrón exacto que sigue este script.
--
-- Placeholders a reemplazar antes de correr, todos marcados <ASI>:
--   <PHONE_NUMBER_ID>    — Meta's phone_number_id del número REAL de Meli
--                          (NO el número de teléfono)
--   <WABA_ID>            — WhatsApp Business Account ID
--   <PHONE_NUMBER>       — E.164 sin '+' del número REAL, ej. 5491122334455
--   <SYSTEM_USER_TOKEN>  — opcional, token por-WABA; si se omite usa el
--                          system user token global (env var del proyecto)
--   <CALENDLY_LINK>      — ver nota en system_prompt.md, todavía sin resolver
--   <SANTI_PHONE_NUMBER> — el número PERSONAL de Santi, E.164 sin '+', el
--                          único habilitado a hablar con el bot mientras
--                          está en modo prueba (ver bloque 4)
--
-- Orden de ejecución: los cuatro bloques son secuenciales (organization →
-- address → agent → contacto autorizado), cada uno necesita el ID que
-- devuelve el anterior.
--
-- IMPORTANTE — por qué el bloque 4 existe y no es opcional para la prueba
-- con el número real: 'authorized_contacts_only' abajo en el bloque 1 va en
-- `true` a propósito. Sin el contacto de Santi pre-cargado como 'allowed' en
-- el bloque 4, CUALQUIER paciente que le escriba al número real de Meli
-- recibe una respuesta automática del bot desde el momento en que este
-- script corre — no hay "modo prueba" separado del número real, es el mismo
-- número. `authorized_contacts_only=true` + el contacto de Santi autorizado
-- es lo que garantiza que, mientras probamos, el bot le conteste solo a
-- Santi y a nadie más. Ver P05_HANDOFF.md §8 para el detalle de por qué esto
-- hizo falta parchear (el chequeo por-contacto estaba comentado como TODO en
-- el commit pineado — ya resuelto en agent-client/index.ts en esta rama).
--
-- Antes de pasar a producción real con pacientes (después de validar la
-- prueba con Santi), hay que VOLVER A `authorized_contacts_only: false` con
-- un update — si no, el bot va a seguir ignorando a todo el mundo excepto a
-- Santi para siempre.

-- ============================================================
-- 1. Organización
-- ============================================================

insert into public.organizations (name, extra)
values (
  'Vampiresa Meli',
  jsonb_build_object(
    'response_delay_seconds', 3,
    'authorized_contacts_only', true  -- ver nota "IMPORTANTE" arriba
  )
)
returning id;
-- ⬆ anotar el ID devuelto, hace falta para los dos bloques siguientes

-- ============================================================
-- 2. Número de WhatsApp del consultorio
-- ============================================================

insert into public.organizations_addresses (
  organization_id,
  service,
  address,
  status,
  extra
) values (
  '<ORGANIZATION_ID>',                     -- ID del bloque 1
  'whatsapp',
  '<PHONE_NUMBER_ID>',                     -- Meta's phone_number_id
  'connected',
  jsonb_build_object(
    'waba_id',       '<WABA_ID>',
    'phone_number',  '<PHONE_NUMBER>',      -- dígitos E.164 sin '+'
    'verified_name', 'Vampiresa Meli',
    'flow_type',     'existing_phone_number' -- o 'new_phone_number', ver README
    -- 'access_token', '<SYSTEM_USER_TOKEN>' -- opcional, ver header de este archivo
  )
);

-- ============================================================
-- 3. Agente de IA (Claude Haiku 4.5)
-- ============================================================
--
-- El texto de `instructions` de abajo es una copia literal del bloque de
-- código en system_prompt.md — mantenerlos sincronizados a mano si se edita
-- uno de los dos. Usa dollar-quoting ($prompt$...$prompt$) porque el prompt
-- tiene comillas simples adentro (ej. "vos").

insert into public.agents (
  organization_id,
  name,
  ai,
  extra
) values (
  '<ORGANIZATION_ID>',                     -- ID del bloque 1
  'Asistente Vampiresa Meli',
  true,
  jsonb_build_object(
    'mode',        'active',
    'description', 'Responde consultas de servicios/precios/turnos por WhatsApp e Instagram',
    'api_url',     'anthropic',
    -- 'api_key' se omite a propósito: cae al env var ANTHROPIC_API_KEY del
    -- proyecto Supabase (ver chat-completions.ts línea 475). Cargar esa key
    -- como Edge Function secret, no acá.
    'model',       'claude-haiku-4-5',
    'protocol',    'chat_completions',      -- único protocolo soportado hoy
                                             -- para Anthropic (ver P05 §3:
                                             -- sin prompt caching nativo
                                             -- todavía, optimización futura
                                             -- opcional, no bloquea)
    'max_tokens',  300,
    'temperature', 0.7,
    'instructions', $prompt$Sos la asistente virtual del consultorio de la Dra. Melisa (Meli), dermatóloga
especializada en bioestimulación e IPL/NIR en Buenos Aires, Argentina.

Tu única función es atender consultas sobre este consultorio: servicios,
precios, preparación para tratamientos y turnos. No sos un asistente de
propósito general — si te piden algo que no tiene que ver con el consultorio
(tareas, traducciones, preguntas generales, etc.), respondé amablemente que
solo podés ayudar con temas del consultorio.

PERSONALIDAD:
- Cálida, amigable, profesional
- Usá "vos" (Argentina)
- Mensajes cortos (máximo 3-4 líneas por respuesta)
- No usés jerga médica compleja

LO QUE PODÉS HACER:
- Explicar servicios, procedimientos y precios del catálogo de abajo
- Responder preguntas generales sobre cómo prepararse para cada tratamiento
- Mandar el link para agendar cuando la paciente esté lista
- Confirmar disponibilidad general (no fechas específicas — esas están en
  Calendly)

LO QUE NO PODÉS HACER:
- Dar diagnósticos ni consejos médicos personalizados
- Recomendar un tratamiento específico para la condición de piel de alguien
- Confirmar si un tratamiento es apto para embarazo, lactancia, alergias o
  medicación — siempre derivar esto a Meli
- Hablar de precios o servicios que no están en el catálogo de abajo
- Cualquier cosa que no sea sobre este consultorio

CUÁNDO DERIVAR A MELI (usá la herramienta transfer_to_human_agent si está
disponible, y decile a la paciente que ya la vas a contactar):
- Preguntas médicas específicas o sobre su caso particular
- Quejas, reclamos o situaciones delicadas
- Cualquier pedido que no puedas resolver con este prompt

CUÁNDO MANDAR EL LINK DE CALENDLY:
- Cuando la paciente diga que quiere agendar, reservar, o pregunte cómo hacerlo
- Mandá este link: <CALENDLY_LINK>

SERVICIOS Y PRECIOS (vigentes junio 2026 — confirmar actualización de julio
antes de producción):

Consulta
- Consulta médica: $60.000

PRP
- PRP facial: $90.000
- PRP capilar: $80.000
- Promo PRP capilar + cara: $160.000 (combo)

Mesoterapia
- Mesoterapia capilar: $60.000
- Mesoterapia corporal: $60.000

Peeling
- Superficial (incluye punta de diamante): $60.000
- Profundo: $80.000

Mesopeeling
- Ácido hialurónico: $70.000
- Peptonas: $80.000
- Plasma rico: $90.000
- Mesobotox (rosácea, acné, poros dilatados, textura): $120.000
- Meso francesa NCTH: $150.000

Botox
- Tercio superior: $330.000
- Maceteros (bruxismo): $360.000

Bioestimuladores
- HarmonyCa — hidroxiapatita de calcio + ácido hialurónico (tensión, textura e
  hidratación; dura 1-2 años): $600.000
- Radiesse — hidroxiapatita de calcio (tensión y textura; dura 1-2 años):
  $500.000

Skinbooster (glow)
- Skinvive (Allergan, francés): $380.000
- SBL Ácido hialurónico 64mg (Futerman): $300.000
- SBL PDRN-M — ácido hialurónico + PDRN de salmón: $300.000
- SBL Relax — ácido hialurónico + oligopéptidos: $300.000

Rellenos
- Labios: $300.000
- Mentón: $300.000
- Pómulos: $300.000
- Rinomodelación: $400.000
- Armonización facial: a cotizar en la consulta (varía según el plan)

Alma — IPL
- IPL facial: $240.000
- IPL escote: $240.000

Alma — NIR
- NIR facial (recomendado 6 sesiones): $120.000
- NIR corporal (recomendado 6 sesiones): $160.000

Todos los precios son en pesos argentinos, efectivo/transferencia.$prompt$,
    'tools', jsonb_build_array(
      jsonb_build_object('provider', 'local', 'type', 'function', 'name', 'transfer_to_human_agent')
    )
  )
);

-- ============================================================
-- 4. Contacto autorizado — SOLO Santi, mientras dure la prueba
-- ============================================================
--
-- Pre-cargamos el contacto de Santi ANTES de que le escriba por primera vez,
-- para que su primer mensaje ya reciba respuesta (si se crea solo, vía el
-- trigger que engancha contacts_addresses -> contacts en el primer mensaje,
-- nace sin 'allowed', y el chequeo del bloque 1 lo bloquearía también a él).

with new_contact as (
  insert into public.contacts (organization_id, name, extra)
  values (
    '<ORGANIZATION_ID>',                   -- ID del bloque 1
    'Santi (prueba)',
    jsonb_build_object('allowed', true)
  )
  returning id
)
insert into public.contacts_addresses (
  organization_id,
  contact_id,
  service,
  address
)
select
  '<ORGANIZATION_ID>',                     -- ID del bloque 1
  new_contact.id,
  'whatsapp',
  '<SANTI_PHONE_NUMBER>'                   -- número personal de Santi, E.164 sin '+'
from new_contact;

-- ============================================================
-- Para pasar a producción real (después de validar con Santi)
-- ============================================================
-- ✅ Ejecutado 2026-07-26: `authorized_contacts_only` en false y
-- `welcome_message` actualizado al texto con emojis (Botox Party + IPL
-- agosto). Corrido a mano contra la Management API, no vía este script.
-- update public.organizations
-- set extra = extra || '{"authorized_contacts_only": false}'::jsonb
-- where id = '<ORGANIZATION_ID>';
