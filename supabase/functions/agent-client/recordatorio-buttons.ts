/**
 * Ruteo determinístico de las respuestas de botón (Confirmo / Reprogramar /
 * Cancelar) al recordatorio automático de turno de mañana
 * (template `ut_recordatorio_turno`, cron en Vercel — ver
 * `consultorio_dermatologico/scripts/recordatorios_manana.py`).
 *
 * Por qué un módulo aparte, enganchado ANTES del guardrail/ReAct: estas tres
 * respuestas son lógica de negocio 100% determinística (cancelar un turno en
 * Calendly, mandar el link de reprogramación, o simplemente confirmar) — no
 * hace falta, y de hecho conviene evitar, que pasen por el redactor/juez de
 * IA. Si un "Cancelar" llegara a colarse en ese flujo, en el mejor de los
 * casos generaría una respuesta genérica y en el peor, una inconsistente con
 * la cancelación real que hicimos acá (ej. el bot ofreciendo reagendar un
 * turno que ya cancelamos).
 *
 * Se engancha en agent-client/index.ts, inmediatamente después de resolver
 * `conv` y ANTES de cualquier chequeo de contacto autorizado / conversación
 * pausada / agente IA / guardrail — ver el comentario en el call site.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import type {
  ConversationRow,
  MessageInsert,
  MessageRow,
} from "../_shared/supabase.ts";

const CALENDLY_API_BASE = "https://api.calendly.com";

// Debe matchear exactamente `motivo_envio` usado por
// consultorio_dermatologico/scripts/recordatorios_manana.py
// (función enviar_recordatorio).
const MOTIVO_ENVIO_RECORDATORIO = "recordatorio_turno_manana";

const MENSAJE_CONFIRMACION = "¡Genial, te esperamos! 💜";
const MENSAJE_CANCELACION = "Listo, cancelamos tu turno. ¡Que estés bien!";
const MENSAJE_ERROR =
  "Tuvimos un problema para procesar esto, te contactamos a la brevedad 🙏";

type BotonRecordatorio = "Confirmo" | "Reprogramar" | "Cancelar";

const BOTONES_RECORDATORIO: readonly BotonRecordatorio[] = [
  "Confirmo",
  "Reprogramar",
  "Cancelar",
];

/**
 * Datos que `recordatorios_manana.py` deja en la columna `notas` (JSON en
 * texto) de cada fila de `vampiresa_meta_sends_log` al mandar el recordatorio,
 * justamente para que este webhook pueda resolver la respuesta sin volver a
 * consultar Calendly por el turno.
 */
interface NotasRecordatorio {
  event_uuid?: string;
  invitee_uuid?: string;
  reschedule_url?: string;
  tipo_turno?: string;
}

interface EnvioRecordatorioRow {
  id: number;
  numero_telefono: string;
  notas: string | null;
  created_at: string;
}

export interface RecordatorioButtonResult {
  /**
   * true cuando el mensaje entrante era una respuesta a un recordatorio de
   * turno y ya fue resuelto acá (se actuó o se decidió explícitamente no
   * actuar). El caller (agent-client/index.ts) debe cortar el flujo y no
   * pasarle el mensaje al guardrail/agente IA.
   */
  handled: boolean;
}

/**
 * Extrae el título del botón de quick-reply tocado, si el mensaje entrante es
 * uno.
 *
 * El camino real para un botón de un *template* de WhatsApp (que es lo que
 * manda `ut_recordatorio_turno`) es `type: "button"` con
 * `button: { text, payload }` — confirmado contra
 * `webhookMessageToIncomingMessage` (case "button") en
 * `whatsapp-webhook/index.ts` y `ButtonPart` en
 * `_shared/types/message_types.ts`. Ahí `data.text` es el texto visible del
 * botón ("Confirmo", "Reprogramar", "Cancelar").
 *
 * También se contempla, defensivamente, `type: "interactive"` con
 * `interactive.button_reply.title` (botón de un mensaje interactivo nativo,
 * no de un template) — no es el camino que toma un quick-reply de template,
 * pero cubrir ambos shapes no cuesta nada y deja el chequeo a prueba de un
 * futuro cambio a mensajes interactivos.
 */
export function extraerTituloBoton(
  content: MessageRow["content"],
): string | undefined {
  if (content.type !== "data") {
    return undefined;
  }

  if (content.kind === "button") {
    const data = content.data as { text?: string; payload?: string };
    return data?.text;
  }

  if (content.kind === "interactive") {
    const data = content.data as
      | { type: "button_reply"; button_reply: { id: string; title: string } }
      | {
        type: "list_reply";
        list_reply: { id: string; title: string; description?: string };
      };

    if (data?.type === "button_reply") {
      return data.button_reply?.title;
    }
  }

  return undefined;
}

export function esBotonRecordatorio(
  titulo: string | undefined,
): titulo is BotonRecordatorio {
  return !!titulo &&
    (BOTONES_RECORDATORIO as readonly string[]).includes(titulo);
}

/**
 * Inserta la fila outgoing y deja que el trigger de la base
 * (handle_outgoing_message_to_dispatcher) despierte al dispatcher — mismo
 * mecanismo que usa el resto del proyecto (ver enviarMensaje en
 * guardrail/index.ts). No se llama a whatsapp-dispatcher directo.
 */
async function enviarMensaje(
  client: SupabaseClient,
  conversation: ConversationRow,
  texto: string,
): Promise<void> {
  const outgoing: MessageInsert = {
    organization_id: conversation.organization_id,
    conversation_id: conversation.id,
    service: conversation.service,
    organization_address: conversation.organization_address,
    contact_address: conversation.contact_address,
    direction: "outgoing",
    content: {
      version: "1",
      type: "text",
      kind: "text",
      text: texto,
    },
  };

  const { error } = await client.from("messages").insert(outgoing);

  if (error) {
    log.error(
      "Recordatorio de turno — no se pudo insertar el mensaje de salida",
      {
        error,
        texto,
      },
    );
  }
}

async function enviarError(
  client: SupabaseClient,
  conversation: ConversationRow,
): Promise<void> {
  await enviarMensaje(client, conversation, MENSAJE_ERROR);
}

async function manejarConfirmo(
  client: SupabaseClient,
  conversation: ConversationRow,
  notas: NotasRecordatorio,
): Promise<void> {
  // No hay ninguna acción externa que tomar: el turno ya estaba confirmado
  // en Calendly de entrada. Solo se manda el acuse.
  log.info(
    "Recordatorio de turno — Confirmo: sin acción externa, se manda acuse",
    {
      event_uuid: notas.event_uuid,
    },
  );

  await enviarMensaje(client, conversation, MENSAJE_CONFIRMACION);
}

async function manejarReprogramar(
  client: SupabaseClient,
  conversation: ConversationRow,
  notas: NotasRecordatorio,
): Promise<void> {
  if (!notas.reschedule_url) {
    log.error(
      "Recordatorio de turno — Reprogramar: falta reschedule_url en las notas del envío",
      { notas },
    );

    await enviarError(client, conversation);
    return;
  }

  log.info("Recordatorio de turno — Reprogramar: se manda el reschedule_url", {
    event_uuid: notas.event_uuid,
  });

  await enviarMensaje(
    client,
    conversation,
    `Acá podés elegir un nuevo horario: ${notas.reschedule_url}`,
  );
}

async function manejarCancelar(
  client: SupabaseClient,
  conversation: ConversationRow,
  notas: NotasRecordatorio,
): Promise<void> {
  if (!notas.event_uuid) {
    log.error(
      "Recordatorio de turno — Cancelar: falta event_uuid en las notas del envío",
      { notas },
    );

    await enviarError(client, conversation);
    return;
  }

  // TODO(santi): cargar CALENDLY_API_KEY como Edge Function secret del
  // proyecto velvet-agent (`supabase secrets set CALENDLY_API_KEY=...`) si
  // todavía no está. Hoy solo se usa desde
  // consultorio_dermatologico/scripts/recordatorios_manana.py (proceso
  // aparte, en Vercel) — este Edge Function corre en el runtime de Supabase y
  // necesita su propia copia del secret para poder cancelar turnos.
  const apiKey = Deno.env.get("CALENDLY_API_KEY");

  if (!apiKey) {
    log.error(
      "Recordatorio de turno — Cancelar: falta el secret CALENDLY_API_KEY. No se pudo cancelar en Calendly.",
      { event_uuid: notas.event_uuid },
    );

    await enviarError(client, conversation);
    return;
  }

  try {
    const response = await fetch(
      `${CALENDLY_API_BASE}/scheduled_events/${notas.event_uuid}/cancellation`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reason: "Paciente avisó por WhatsApp que no puede asistir",
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");

      log.error("Recordatorio de turno — Cancelar: Calendly respondió error", {
        status: response.status,
        body,
        event_uuid: notas.event_uuid,
      });

      await enviarError(client, conversation);
      return;
    }

    log.info("Recordatorio de turno — Cancelar: turno cancelado en Calendly", {
      event_uuid: notas.event_uuid,
    });

    await enviarMensaje(client, conversation, MENSAJE_CANCELACION);
  } catch (error) {
    log.error(
      "Recordatorio de turno — Cancelar: fallo de red al llamar a Calendly",
      { error, event_uuid: notas.event_uuid },
    );

    await enviarError(client, conversation);
  }
}

/**
 * Punto de entrada. Devuelve `{ handled: true }` cuando el mensaje entrante
 * era un tap de botón de recordatorio y ya se resolvió (con o sin acción
 * externa) — el caller debe cortar el flujo ahí. Devuelve `{ handled: false }`
 * en cualquier otro caso (no es un botón de recordatorio, o es un botón pero
 * no hay ningún envío de recordatorio reciente para ese número), dejando que
 * el mensaje siga su camino normal hacia el guardrail/agente IA.
 */
export async function handleRecordatorioButtonReply(
  { client, conversation, incoming }: {
    client: SupabaseClient;
    conversation: ConversationRow;
    incoming: MessageRow;
  },
): Promise<RecordatorioButtonResult> {
  // Solo WhatsApp: el cron de recordatorios (`ut_recordatorio_turno`) manda
  // por ese canal exclusivamente, y es el único donde los quick-reply
  // buttons de un template llegan con este shape.
  if (
    incoming.direction !== "incoming" || conversation.service !== "whatsapp"
  ) {
    return { handled: false };
  }

  const boton = extraerTituloBoton(incoming.content);

  if (!esBotonRecordatorio(boton)) {
    return { handled: false };
  }

  if (!conversation.contact_address) {
    log.warn(
      `Recordatorio de turno — botón "${boton}" tocado pero la conversación no tiene contact_address. No se puede buscar el envío.`,
      { conversation_id: conversation.id },
    );

    return { handled: false };
  }

  log.info(`Recordatorio de turno — botón tocado: "${boton}"`, {
    conversation_id: conversation.id,
    contact_address: conversation.contact_address,
  });

  const { data: envio, error: envioError } = await client
    .from("vampiresa_meta_sends_log")
    .select("id, numero_telefono, notas, created_at")
    .eq("motivo_envio", MOTIVO_ENVIO_RECORDATORIO)
    .eq("numero_telefono", conversation.contact_address)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (envioError) {
    // Fail-open a propósito: si no se puede ni consultar el log, no hay con
    // qué actuar. Se deja caer al flujo normal en vez de dejar a la persona
    // sin ninguna respuesta.
    log.error(
      "Recordatorio de turno — no se pudo consultar vampiresa_meta_sends_log",
      envioError,
    );

    return { handled: false };
  }

  if (!envio) {
    // Caso raro pero posible: alguien tocó un botón de un template viejo, o
    // el número no matchea ningún envío nuestro. No hacemos nada raro — se
    // loguea y se deja pasar al flujo normal (el guardrail ya sabe responder
    // con la redirección fija a mail ante un mensaje no textual).
    log.info(
      `Recordatorio de turno — botón "${boton}" tocado pero no hay ningún envío ` +
        `"${MOTIVO_ENVIO_RECORDATORIO}" reciente para ${conversation.contact_address}. No se actúa.`,
    );

    return { handled: false };
  }

  const row = envio as EnvioRecordatorioRow;

  let notas: NotasRecordatorio;

  try {
    notas = JSON.parse(row.notas ?? "{}");
  } catch (error) {
    log.error(
      "Recordatorio de turno — no se pudo parsear las notas del envío",
      {
        error,
        envio_id: row.id,
        notas: row.notas,
      },
    );

    await enviarError(client, conversation);
    return { handled: true };
  }

  switch (boton) {
    case "Confirmo":
      await manejarConfirmo(client, conversation, notas);
      break;
    case "Reprogramar":
      await manejarReprogramar(client, conversation, notas);
      break;
    case "Cancelar":
      await manejarCancelar(client, conversation, notas);
      break;
  }

  return { handled: true };
}
