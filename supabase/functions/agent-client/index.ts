import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  type ContactRow,
  createUnsecureClient,
  type DataPart,
  type InternalMessage,
  type LocalMCPToolConfig,
  type MessageInsert,
  type MessageRow,
  type OutgoingMessage,
  type Part,
  type TextPart,
  type ToolInfo,
  type WebhookPayload,
} from "../_shared/supabase.ts";
import { ProtocolFactory } from "./protocols/index.ts";
import { registrarNoEnviada, runGuardrail } from "./guardrail/index.ts";
import type { GuardrailTurn } from "./guardrail/anthropic.ts";
import { transcribirAudio } from "./guardrail/transcripcion.ts";
import { handleRecordatorioButtonReply } from "./recordatorio-buttons.ts";
import { callTool, initMCP, type MCPServer } from "./tools/mcp.ts";
import { Toolbox } from "./tools/index.ts";
import { z } from "zod";
import Ajv2020 from "ajv";
import type { AgentRowWithExtra, ResponseContext } from "./protocols/base.ts";
import { getFileMetadata } from "../_shared/media.ts";
import { type MessageRowV0, toV1 } from "../_shared/messages-v0.ts";

const sanitizeLabel = (label: string) => {
  return label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]/g, "_");
};

export type AgentTool = {
  provider: "local";
  type: "function" | "custom" | "mcp" | "http" | "sql";
  label?: string;
  name: string;
  description?: string;
  inputSchema: z.core.JSONSchema.JSONSchema;
  outputSchema?: z.core.JSONSchema.JSONSchema;
  // deno-lint-ignore no-explicit-any
  implementation?: any;
  // deno-lint-ignore no-explicit-any
  config?: any;
};

const PAUSED_CONV_WINDOW = 12 * 60 * 60 * 1000; // 12 hours
const MESSAGES_TIME_LIMIT = 7 * 24 * 60 * 60 * 1000; // 7 days
const MESSAGES_QUANTITY_LIMIT = 50;
// How long a conversation must be free of outgoing messages before the
// welcome message fires again. Kept independent of MESSAGES_TIME_LIMIT
// (which bounds the AI agent's context window) so tuning one doesn't
// silently change the other.
const WELCOME_MESSAGE_INACTIVITY_WINDOW = 24 * 60 * 60 * 1000; // 24 hours
const RESPONSE_DELAY_SECS = 3; // 3 seconds
const MEDIA_PREPROCESSING_TIMEOUT = 30 * 1000; // 30 seconds
const MEDIA_PREPROCESSING_POLLING_INTERVAL = 5 * 1000; // 5 seconds

/**
 * Candado por conversación (ver agent_guardrails.sql sección 6). Cierra la
 * race condition real de 2026-08-13: dos mensajes entrantes separados por
 * más que RESPONSE_DELAY_SECS/response_delay_seconds pero por menos que
 * BURST_MAX_GAP_MS disparaban dos invocaciones de agent-client en paralelo,
 * y la de "CHECK IF THERE IS A NEWER MESSAGE" de arriba solo comparaba
 * contra mensajes ENTRANTES — nunca contra una respuesta que la otra
 * invocación ya hubiera mandado mientras tanto. Mismo defecto de fondo que
 * el riesgo (nunca confirmado hasta ahora) de agendar el mismo turno dos
 * veces en Calendly.
 *
 * CONVERSATION_LOCK_TTL_SECS está por encima del deadline real de la
 * pipeline en frío (~55s, ver golden set 2026-08-09) — un candado más viejo
 * se considera abandonado (invocación que crasheó) y se puede retomar.
 */
const CONVERSATION_LOCK_TTL_SECS = 90;
const CONVERSATION_LOCK_POLL_MS = 2 * 1000;
const CONVERSATION_LOCK_MAX_WAIT_MS = 90 * 1000;

async function tomarCandadoConversacion(
  client: SupabaseClient,
  conversationId: string,
  invocationId: string,
): Promise<boolean> {
  const { data, error } = await client.rpc("claim_conversation_processing", {
    _conversation_id: conversationId,
    _invocation_id: invocationId,
    _ttl_seconds: CONVERSATION_LOCK_TTL_SECS,
  });

  if (error) {
    // Fail-open a propósito: un problema con el candado en sí (RPC caído,
    // función sin correr en esta base) no debería silenciar al bot — es
    // preferible volver al riesgo de duplicado ocasional que dejar de
    // contestar. Se loguea para poder notarlo.
    log.error(
      "No se pudo chequear el candado de conversación (se sigue sin candado, fail-open)",
      error,
    );

    return true;
  }

  return data === true;
}

async function soltarCandadoConversacion(
  client: SupabaseClient,
  conversationId: string,
  invocationId: string,
): Promise<void> {
  const { error } = await client.rpc("release_conversation_processing", {
    _conversation_id: conversationId,
    _invocation_id: invocationId,
  });

  if (error) {
    // No es crítico: el candado se autolimpia por TTL (CONVERSATION_LOCK_TTL_SECS).
    log.error(
      "No se pudo soltar el candado de conversación (se autolimpia por TTL)",
      error,
    );
  }
}

/**
 * timestamp vs created_at
 *
 *  - timestamp is given by the service (i.e. WhatsApp) servers.
 *  - created_at is the insertion timestamp in our database.
 *
 *  The contact might send several messages very close in time. The goal is to react
 *  once for the whole batch. Each message will trigger a function. Only one of them
 *  should go through. The selection criteria is the function corresponding to the
 *  newest message by created_at.
 *
 *  The newest message might not be the one with the latest timestamp. The order of
 *  arrival is not guaranteed. Anyway, messages are ordered by timestamp, hence the
 *  agent will get the conversation history in the correct order.
 */

function getNewestIncomingMessage(
  incoming: MessageRow,
  messages: MessageRow[],
) {
  const incomingCreatedAt = new Date(incoming.created_at);

  const sortedMessages = messages
    .filter((m) => m.direction === "incoming")
    .filter((m) => new Date(m.created_at) >= incomingCreatedAt)
    .sort((a, b) => {
      const dateA = +new Date(a.created_at);
      const dateB = +new Date(b.created_at);

      if (dateA !== dateB) {
        return dateB - dateA; // descending by created_at
      }

      // If created_at is the same, order by id descending
      if (a.id < b.id) return 1;
      if (a.id > b.id) return -1;
      return 0;
    });

  return sortedMessages[0];
}

/**
 * Ventana máxima entre dos mensajes de la misma "tanda" (ver
 * `getIncomingBurstText`). Más que esto ya no es alguien tipeando seguido,
 * es una conversación distinta — no hay que fusionarlas.
 */
const BURST_MAX_GAP_MS = 2 * 60 * 1000;

/**
 * Junta el texto de todos los mensajes ENTRANTES consecutivos que terminan en
 * `newestMessage`, sin ningún mensaje saliente en el medio y sin que pase más
 * de `BURST_MAX_GAP_MS` entre uno y el siguiente — cubre el caso de alguien
 * mandando la misma idea en varios mensajes seguidos ("Quiero saber del
 * botox" + "y cuánto sale"). Solo tiene sentido cuando `messages` ya viene en
 * orden cronológico ascendente.
 *
 * Antes el guardrail solo miraba el texto del último mensaje de la tanda, así
 * que perdía el contexto de los anteriores (encontrado 2026-08-02 probando en
 * vivo: "hola" + "que tal" mandados seguidos hacían que el redactor solo viera
 * "que tal", sin problema porque ambos eran equivalentes, pero con contenido
 * distinto se hubiera perdido información real).
 *
 * El límite de tiempo se agregó el mismo día al encontrar el caso contrario:
 * si el juez rechaza cada borrador, nunca se inserta un mensaje saliente que
 * corte la racha, así que sin este tope la función seguía juntando TODOS los
 * mensajes sin responder de la conversación (en un caso real, más de una hora
 * y cuatro mensajes de temas distintos en un solo bloque), produciendo un
 * `mensajePaciente` mezclado que ningún tipo de respuesta podía cubrir bien.
 *
 * Mensajes no textuales dentro de la tanda no se concatenan (no hay texto que
 * sumar de una foto) pero tampoco cortan la racha (si están dentro de la
 * ventana de tiempo).
 */
/**
 * Índice del primer mensaje de la "tanda" que termina en `newestMessage`
 * (ver `getIncomingBurstText`) — factorizado para que `getRecentHistoryTurns`
 * corte el historial justo ANTES de la tanda actual, en vez de en
 * `newestIndex`. Antes de este fix el historial y `mensajePaciente` se
 * superponían: si la paciente mandaba "hola" + "cuánto sale el botox"
 * seguidos, "hola" viajaba en el bloque de historial Y dentro de
 * `mensajePaciente` (encontrado 2026-08-06, ver
 * `proyectos/P05_plan_tools_turnos.md` sección 2.6 en `consultorio_dermatologico`).
 */
function indiceInicioTanda(
  messages: MessageRow[],
  newestMessage: MessageRow,
): number {
  const newestIndex = messages.findIndex((m) => m.id === newestMessage.id);

  if (newestIndex === -1) return messages.length;

  let ultimoTimestamp = +new Date(messages[newestIndex].created_at);
  let i = newestIndex;

  for (; i >= 0; i--) {
    const mensaje = messages[i];

    if (mensaje.direction !== "incoming") break;

    const timestamp = +new Date(mensaje.created_at);

    if (ultimoTimestamp - timestamp > BURST_MAX_GAP_MS) break;

    ultimoTimestamp = timestamp;
  }

  return i + 1;
}

/**
 * Junta el texto de todos los mensajes ENTRANTES consecutivos que terminan en
 * `newestMessage`, sin ningún mensaje saliente en el medio y sin que pase más
 * de `BURST_MAX_GAP_MS` entre uno y el siguiente — cubre el caso de alguien
 * mandando la misma idea en varios mensajes seguidos ("Quiero saber del
 * botox" + "y cuánto sale"). Solo tiene sentido cuando `messages` ya viene en
 * orden cronológico ascendente.
 *
 * Antes el guardrail solo miraba el texto del último mensaje de la tanda, así
 * que perdía el contexto de los anteriores (encontrado 2026-08-02 probando en
 * vivo: "hola" + "que tal" mandados seguidos hacían que el redactor solo viera
 * "que tal", sin problema porque ambos eran equivalentes, pero con contenido
 * distinto se hubiera perdido información real).
 *
 * El límite de tiempo se agregó el mismo día al encontrar el caso contrario:
 * si el juez rechaza cada borrador, nunca se inserta un mensaje saliente que
 * corte la racha, así que sin este tope la función seguía juntando TODOS los
 * mensajes sin responder de la conversación (en un caso real, más de una hora
 * y cuatro mensajes de temas distintos en un solo bloque), produciendo un
 * `mensajePaciente` mezclado que ningún tipo de respuesta podía cubrir bien.
 *
 * Mensajes no textuales dentro de la tanda no se concatenan (no hay texto que
 * sumar de una foto) pero tampoco cortan la racha (si están dentro de la
 * ventana de tiempo).
 */
function getIncomingBurstText(
  messages: MessageRow[],
  newestMessage: MessageRow,
): string {
  const newestIndex = messages.findIndex((m) => m.id === newestMessage.id);

  if (newestIndex === -1) {
    return newestMessage.content.type === "text"
      ? newestMessage.content.text
      : "";
  }

  const inicio = indiceInicioTanda(messages, newestMessage);
  const textos: string[] = [];

  for (let i = inicio; i <= newestIndex; i++) {
    const mensaje = messages[i];

    if (mensaje.content.type === "text" && mensaje.content.text.trim()) {
      textos.push(mensaje.content.text.trim());
    }
  }

  return textos.join("\n");
}

/**
 * Cuántos mensajes anteriores a la tanda actual se le pasan al redactor como
 * historial de corto plazo (ver `proyectos/P05_plan_tools_turnos.md`,
 * sección 2.6, en `consultorio_dermatologico`). Decisión de costo de Santi
 * 2026-08-05, no un límite técnico — no cambia con la migración a turnos
 * reales de 2026-08-06.
 */
const HISTORIAL_RECIENTE_MAX_MENSAJES = 10;

/**
 * Últimos `maxMessages` mensajes anteriores a la tanda actual, como turnos
 * reales de la Messages API (`role: "user" | "assistant"`) — reemplaza el
 * bloque de texto plano embebido en el `system` que se usaba hasta v10 (ver
 * el comentario largo en `guardrail/anthropic.ts` sobre por qué). Mensajes
 * "internal" se filtran (ruido de plataforma, no diálogo con la paciente).
 *
 * Turnos consecutivos del mismo rol se colapsan en uno solo (la Messages API
 * exige roles alternados: `user`, `assistant`, `user`, ...) y los turnos
 * `assistant` iniciales se descartan (el primer turno tiene que ser `user`).
 * Cada turno de la paciente queda cercado en `<mensaje_paciente>` — mismo
 * criterio que ya usa `userRedactor` para el mensaje actual, para no bajar la
 * guardia de prompt injection en los turnos históricos (ver
 * `prompts.ts::userRedactor`).
 */
function getRecentHistoryTurns(
  messages: MessageRow[],
  newestMessage: MessageRow,
  maxMessages: number,
): GuardrailTurn[] {
  const newestIndex = messages.findIndex((m) => m.id === newestMessage.id);

  if (newestIndex <= 0) return [];

  const finHistorial = Math.min(
    indiceInicioTanda(messages, newestMessage),
    newestIndex,
  );
  const desde = Math.max(0, finHistorial - maxMessages);

  const turnos: GuardrailTurn[] = [];

  for (const m of messages.slice(desde, finHistorial)) {
    const role = m.direction === "incoming"
      ? "user" as const
      : m.direction === "outgoing"
      ? "assistant" as const
      : null;

    if (!role) continue;

    const texto = m.content.type === "text"
      ? m.content.text.trim()
      : "[mensaje no textual]";

    if (!texto) continue;

    const contenido = role === "user"
      ? `<mensaje_paciente>\n${texto}\n</mensaje_paciente>`
      : texto;

    const ultimo = turnos[turnos.length - 1];

    if (ultimo && ultimo.role === role) {
      ultimo.content += "\n" + contenido;
    } else {
      turnos.push({ role, content: contenido });
    }
  }

  while (turnos.length && turnos[0].role !== "user") {
    turnos.shift();
  }

  return turnos;
}

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (token !== SERVICE_ROLE_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = createUnsecureClient();

  const incoming = ((await req.json()) as WebhookPayload<MessageRow>).record!;

  // RETRIEVE CONVERSATION + ORGANIZATION + CONTACT + AGENTS (via organization, one-hop join)

  const { data: conv } = await client
    .from("conversations")
    .select(`
      *,
      organizations (*, agents (*)),
      contacts_addresses (*, contacts (*))
    `)
    .eq("id", incoming.conversation_id)
    .single()
    .throwOnError();

  if (!conv.extra) {
    conv.extra = {};
  }

  const {
    organizations: org,
    contacts_addresses: contact_address,
    ...conversation
  } = conv;

  log.info("Agent client context", {
    conversation_id: conv.id,
    has_org: !!org,
    has_contact_address: !!contact_address,
  });

  // RECORDATORIO DE TURNO — RUTEO DE BOTONES (Confirmo / Reprogramar / Cancelar)
  //
  // Chequeo temprano, en el mismo espíritu que el chequeo de "mensaje no
  // textual" que hace el guardrail más abajo, pero un escalón antes: corre
  // ANTES de "CHECK IF CONTACT IS ALLOWED", "CHECK IF CONVERSATION IS PAUSED",
  // el mensaje de bienvenida y la selección de agente IA — ninguno de esos
  // gates de conversación aplica acá, porque esto no es una conversación con
  // el bot: es la respuesta determinística a un template que YA mandamos
  // nosotros (el recordatorio de turno de mañana, cron en Vercel). Si un
  // "Cancelar" llegara a colarse en el guardrail/ReAct de más abajo, podría
  // generar una respuesta de IA inconsistente con la cancelación real que
  // hacemos acá. Ver recordatorio-buttons.ts para el detalle completo.
  const recordatorioResult = await handleRecordatorioButtonReply({
    client,
    conversation,
    incoming,
  });

  if (recordatorioResult.handled) {
    return new Response("ok", { headers: corsHeaders });
  }

  const organization_id = org.id;

  if (!org.extra) {
    org.extra = {};
  }

  const { agents, ...organization } = org;

  let contact: ContactRow | undefined;

  if (contact_address) {
    contact = contact_address.contacts || undefined;

    if (!contact_address.extra) {
      contact_address.extra = {};
    }

    if (!contact && contact_address.extra.name) {
      contact = {
        name: contact_address.extra.name,
      } as ContactRow;
    }
  }

  if (contact) {
    if (!contact.extra) {
      contact.extra = {};
    }
  }

  // CHECK IF CONTACT IS ALLOWED

  /**
   * Default behavior: Respond to all contacts.
   *
   * When org.extra.authorized_contacts_only is true, only respond to allowed contacts.
   *
   * An allowed contact has the contact.extra.allowed field set to true.
   */

  if (
    conv.service !== "local" &&
    org.extra.authorized_contacts_only &&
    !contact?.extra?.allowed
  ) {
    log.info(
      `Conversation ${conv.id} does not correspond to an authorized contact. Skipping response.`,
    );

    return new Response("ok", { headers: corsHeaders });
  }

  // CHECK IF CONTACT IS BLOCKED

  if (contact?.extra?.blocked) {
    log.info(
      `Conversation ${conv.id} corresponds to a blocked contact. Skipping response.`,
    );

    return new Response("ok", { headers: corsHeaders });
  }

  // CHECK IF CONVERSATION IS PAUSED

  if (
    conv.extra.paused &&
    +new Date(conv.extra.paused) > +new Date() - PAUSED_CONV_WINDOW
  ) {
    log.info(`Conversation ${conv.id} is paused. Skipping response.`);

    return new Response("ok", { headers: corsHeaders });
  }

  // WAIT FOR A NEWER MESSAGE

  const delay = (org.extra.response_delay_seconds ?? RESPONSE_DELAY_SECS) *
    1000;

  if (delay > 0) {
    log.info(`Waiting ${delay}ms before processing the message...`);

    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  // RETRIEVE MESSAGES

  const { data: messagesMixedVersions } = await client
    .from("messages")
    .select()
    .eq("conversation_id", incoming.conversation_id)
    .gt("timestamp", new Date(+new Date() - MESSAGES_TIME_LIMIT).toISOString()) // Time constraint for the conversation.
    .lte("timestamp", new Date().toISOString()) // Scheduled messages have a future timestamp.
    .order("timestamp", { ascending: false })
    .limit(MESSAGES_QUANTITY_LIMIT) // Size constraint for the conversation.
    .throwOnError();

  const messages = messagesMixedVersions
    .map((m) =>
      m.content.version === "1" ? m : toV1(m as unknown as MessageRowV0)
    )
    .filter(Boolean) as MessageRow[];

  // Query was done in descending order to apply the limit.
  // We need the messages in chronological order, though.
  messages.reverse();

  // CHECK IF THERE IS A NEWER MESSAGE
  const newestMessage = getNewestIncomingMessage(incoming, messages);

  if (newestMessage.id !== incoming.id) {
    // Then the newest message is not the incoming one that triggered this edge function.
    log.info(
      `Newer message ${newestMessage.id} found for conversation ${conv.id}. Skipping response.`,
    );

    return new Response("ok", { headers: corsHeaders });
  }

  // CLAIM THE CONVERSATION LOCK
  //
  // El chequeo de arriba solo descarta esta invocación si YA existe un
  // mensaje entrante más nuevo en este instante. No alcanza cuando dos
  // mensajes llegan separados por más que el debounce corto de arriba pero
  // dentro de la misma "tanda" (BURST_MAX_GAP_MS, ver getIncomingBurstText):
  // las dos invocaciones pasan ese chequeo (ninguna ve a la otra como "más
  // nueva" en su momento) y las dos terminan generando y mandando una
  // respuesta — bug real de producción 2026-08-13, ver comentario en
  // agent_guardrails.sql sección 6.
  const invocationId = incoming.id;

  let candadoTomado = await tomarCandadoConversacion(
    client,
    incoming.conversation_id,
    invocationId,
  );

  const candadoDeadline = Date.now() + CONVERSATION_LOCK_MAX_WAIT_MS;

  while (!candadoTomado && Date.now() < candadoDeadline) {
    log.info(
      `Conversation ${conv.id} is locked by another invocation. Waiting...`,
    );

    await new Promise((resolve) =>
      setTimeout(resolve, CONVERSATION_LOCK_POLL_MS)
    );

    // Mientras esperábamos, puede haber llegado un mensaje más nuevo — esa
    // invocación (cuando le toque correr) se hace cargo de todo, incluido
    // este mensaje, vía getIncomingBurstText. No hace falta competir por el
    // candado si ya no somos la tanda vigente.
    const { data: mensajesAlEsperar } = await client
      .from("messages")
      .select()
      .eq("conversation_id", incoming.conversation_id)
      .gt(
        "timestamp",
        new Date(+new Date() - MESSAGES_TIME_LIMIT).toISOString(),
      )
      .lte("timestamp", new Date().toISOString())
      .order("timestamp", { ascending: false })
      .limit(MESSAGES_QUANTITY_LIMIT)
      .throwOnError();

    const messagesAlEsperar = (mensajesAlEsperar ?? [])
      .map((m) =>
        m.content.version === "1" ? m : toV1(m as unknown as MessageRowV0)
      )
      .filter(Boolean) as MessageRow[];

    messagesAlEsperar.reverse();

    const newestWhileWaiting = getNewestIncomingMessage(
      incoming,
      messagesAlEsperar,
    );

    if (newestWhileWaiting.id !== incoming.id) {
      log.info(
        `Newer message ${newestWhileWaiting.id} found while waiting for the conversation lock. Skipping response.`,
      );

      return new Response("ok", { headers: corsHeaders });
    }

    candadoTomado = await tomarCandadoConversacion(
      client,
      incoming.conversation_id,
      invocationId,
    );
  }

  if (!candadoTomado) {
    log.error(
      `Could not acquire the conversation lock for ${conv.id} after ${CONVERSATION_LOCK_MAX_WAIT_MS}ms. Skipping response to avoid a racy duplicate.`,
    );

    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // SESSION RESTART if /new is found — USEFUL FOR WHATSAPP TESTING

    const firstMessageIndex = messages.findLastIndex(
      ({ direction, content }) =>
        direction === "incoming" &&
        content.type === "text" &&
        content.text.startsWith("/new"),
    );

    if (firstMessageIndex > -1) {
      const firstMessage = messages[firstMessageIndex].content as TextPart;

      firstMessage.text = firstMessage.text.replace("/new", "");

      messages.splice(0, firstMessageIndex);

      // Also, reset the conversation memory
      if (conv.extra.memory && Object.keys(conv.extra.memory).length) {
        conv.extra.memory = {};

        await client
          .from("conversations")
          .update({ extra: conv.extra })
          .eq("id", incoming.conversation_id)
          .throwOnError();
      }
    }

    log.info("Contact request", messages.at(-1)?.content);

    // WELCOME MESSAGE
    // Note: The welcome message is affected by allowed contacts. This behavior
    // differs from WhatsApp, which sends the welcome message to all contacts.
    //
    // Mirrors WhatsApp Business App's native greeting message: it fires once
    // whenever a contact writes in after the conversation has had no outgoing
    // message for WELCOME_MESSAGE_INACTIVITY_WINDOW. `messages` already covers
    // a wider window (MESSAGES_TIME_LIMIT, for AI context) so we just narrow it
    // here instead of issuing a second query.

    const recentMessages = messages.filter(
      (m) =>
        +new Date(m.timestamp) >
          +new Date() - WELCOME_MESSAGE_INACTIVITY_WINDOW,
    );

    if (
      org.extra.welcome_message &&
      recentMessages.every((m) => m.direction !== "outgoing")
    ) {
      // `agent_id` tiene que apuntar a un agente con `ai: true`, si no
      // `pause_conversation_on_human_message` (trigger de Postgres) va a
      // tratar este mensaje automático como si lo hubiera mandado un humano y
      // va a pausar la conversación 12hs — dejando al agente de IA mudo justo
      // después de saludar. Bug real encontrado 2026-08-02 probando el
      // guardrail: el mensaje de bienvenida se mandaba con agent_id null.
      const aiAgentId = agents.find((a) => a.ai)?.id ?? null;

      const outgoing: MessageInsert = {
        organization_id: conv.organization_id,
        conversation_id: conv.id,
        service: conv.service,
        organization_address: conv.organization_address,
        contact_address: conv.contact_address,
        direction: "outgoing",
        agent_id: aiAgentId,
        content: {
          version: "1",
          type: "text",
          kind: "text",
          text: org.extra.welcome_message,
        },
      };

      log.info("Welcome message", (outgoing.content as TextPart).text);

      await client
        .from("messages")
        .insert(outgoing)
        .throwOnError();

      // NO cortar acá (bug real encontrado 2026-08-08, ver
      // PLAN_FIX_BIENVENIDA_CONTEXTO.md): este `if` solo decide si corresponde
      // mandar el saludo automático, no si hay algo más que contestar. Un
      // `return` acá significaba que el contenido real del primer mensaje de
      // la paciente (o del primero después de 24hs de silencio) nunca llegaba
      // al guardrail — si no volvía a escribir, su pregunta se perdía para
      // siempre. Se sigue de largo hacia el resto del pipeline con el mismo
      // mensaje entrante.
      //
      // Trade-off aceptado a propósito, no resuelto: si este primer mensaje
      // real termina clasificado como `saludo_generico` (la paciente solo
      // escribió "hola", sin pregunta), la paciente recibe el saludo canned
      // de arriba MÁS la presentación completa que redacta el modelo — el
      // modelo no sabe que ya se mandó un saludo en este mismo llamado,
      // porque `messages` (usado más abajo para historial/burst) se cargó
      // antes de este insert. Doble saludo cosmético, no un silencio — se
      // prioriza no perder preguntas reales por sobre evitar esta duplicación.
    }

    // CHECK IF THERE ARE AI AGENTS

    const aiAgents = agents.filter(
      (agent) => agent.ai,
    ) as AgentRowWithExtra[];

    if (!aiAgents.length) {
      log.info(
        `No AI agents found for conversation ${conv.id}. Skipping response.`,
      );
      return new Response("ok", { headers: corsHeaders });
    }

    // AGENT SELECTION

    let agent: AgentRowWithExtra | null | undefined;

    /* Not featuring multiple agents per conversation by the time being.

  // 1. Find the agent_id of the last message from an AI agent

  const lastAgentId = messages.findLast((m) => m.agent_id)?.agent_id;

  agent = aiAgents.find((a) => a.id === lastAgentId);

  // 2. Fallback to the contact's group default agent

  const groupAgentMap = org.extra.default_agent_id_by_contact_group;

  if (!agent && groupAgentMap) {
    const defaultAgentId =
      groupAgentMap[conv.contacts?.extra?.group || "undefined"];

    agent = aiAgents.find((a) => a.id === defaultAgentId);
  }
  */

    // 4. Use the agent defined in the conversation
    // For internal conversations, the agent does need to be active.

    agent = aiAgents.find((a) =>
      (conv.service === "local" || a.extra?.mode !== "inactive") &&
      a.id === conversation.extra?.default_agent_id
    );

    // 3. Fallback to the oldest active agent

    if (!agent) {
      agent = aiAgents.filter((a) => a.extra?.mode !== "inactive").sort((
        a,
        b,
      ) => +a.created_at - +b.created_at).at(0);
    }

    if (!agent) {
      log.info(
        `No active AI agents found for conversation ${conv.id}. Skipping response.`,
      );
      return new Response("ok", { headers: corsHeaders });
    }

    //---------------------------------------------------------------------------
    // Up to this point all checks passed. We can proceed with the response.
    //---------------------------------------------------------------------------

    // GUARDRAIL DE DOS PASOS (redactor + juez)
    //
    // Cuando el agente tiene `extra.guardrail: true`, se corre un pipeline
    // determinístico de dos llamados a Claude en vez del bucle ReAct genérico de
    // abajo. Es una feature de seguridad médica (consultorio dermatológico): el
    // bot solo puede repetir lo que está en el catálogo autorizado, y un segundo
    // modelo verifica cada mensaje antes de que salga.
    //
    // Va ANTES del typing indicator a propósito: uno de los resultados posibles
    // es no contestar nada, y mostrar "escribiendo..." para después quedarse
    // callado es peor que no mostrar nada.
    //
    // Ver supabase/functions/agent-client/guardrail/ y
    // supabase/vampiresa_meli/agent_guardrails.sql.

    if (agent.extra?.guardrail) {
      const incomingContent = newestMessage.content;

      // Si el último mensaje es texto, se junta con los textuales anteriores de
      // la misma tanda (ver getIncomingBurstText) para no perder contexto
      // cuando la paciente escribe la idea repartida en varios mensajes.
      let mensajePaciente = incomingContent.type === "text"
        ? getIncomingBurstText(messages, newestMessage)
        : "";

      // Un texto en blanco se trata como no textual: el guardrail responde con la
      // redirección fija a mail en vez de mandarle al modelo un mensaje vacío.
      let tipoMensaje: string = incomingContent.type || "unknown";

      if (tipoMensaje === "text" && !mensajePaciente.trim()) {
        tipoMensaje = "texto vacío";
      }

      // AUDIO — transcripción con Gemini ANTES del guardrail (2026-08-09).
      //
      // Solo audio, no foto/video/documento (esos siguen con la redirección
      // fija a mail más abajo, sin cambios — decisión de Santi, alcance
      // acotado a audio por ahora). Si Gemini transcribe bien, el mensaje
      // sigue el pipeline redactor/juez normal como si fuera texto tipeado. Si
      // falla (config inactiva, sin voz reconocible, error de Gemini, cuota
      // agotada), no se manda nada — fail-closed, mismo criterio que el resto
      // del guardrail (decisión de Santi 2026-08-09: silencio, no la
      // redirección fija, para no mandar un mensaje "de más" por un problema
      // nuestro de transcripción).
      if (incomingContent.type === "file" && incomingContent.kind === "audio") {
        const resultado = await transcribirAudio(client, org, incomingContent);

        if (resultado.ok) {
          mensajePaciente =
            `(Este mensaje es una transcripción automática de un audio de WhatsApp — puede tener errores de reconocimiento de voz.)\n${resultado.texto}`;
          tipoMensaje = "text";
        } else {
          log.info(
            `Guardrail — audio sin transcripción, silencio: ${resultado.motivo}`,
          );

          await registrarNoEnviada(client, conv, contact, {
            mensajePaciente: "[audio]",
            tipo: "silencio",
            mensajeBorrador: "",
            motivo: `transcripción de audio falló: ${resultado.motivo}`,
          });

          return new Response(
            JSON.stringify({
              enviado: false,
              motivo:
                `silencio por audio sin transcripción (${resultado.motivo})`,
            }),
            {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
      }

      const historialTurnos = getRecentHistoryTurns(
        messages,
        newestMessage,
        HISTORIAL_RECIENTE_MAX_MENSAJES,
      );

      const result = await runGuardrail({
        client,
        conversation: conv,
        contact,
        agent,
        tipoMensaje,
        mensajePaciente,
        historialTurnos,
        incomingMessageId: newestMessage.id,
        headers: {
          "organization-id": organization_id,
          "conversation-id": conv.id,
          "agent-id": agent.id,
        },
      });

      log.info("Guardrail — resultado", result);

      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // TYPING INDICATOR

    const indicateTyping = async (unread?: boolean) => {
      const { error: typingIndicatorError } = await client
        .from("messages")
        .update({
          status: {
            ...(unread && { read: new Date().toISOString() }),
            typing: new Date().toISOString(),
          },
        })
        .eq("id", incoming.id);

      if (typingIndicatorError) {
        log.warn(
          "Failed to update incoming message typing indicator status.",
          typingIndicatorError,
        );
      }
    };

    indicateTyping(true);

    // The typing indicator will be dismissed once an agent respond,
    // or after 25 seconds. Hence, keep it alive. Some extra delay
    // is added to avoid race conditions with the response.
    const typingInterval = setInterval(indicateTyping, 30000);

    // CONTEXT

    if (!agent.extra) {
      agent.extra = {};
    }

    const context = {
      organization,
      conversation,
      messages,
      contact,
      agent: agent as AgentRowWithExtra,
    };

    if (agent.extra.tools) {
      for (const tool of agent.extra.tools) {
        if ("label" in tool) {
          tool.label = sanitizeLabel(tool.label);
        }
      }
    }

    // REQUEST LOOP

    /**
     * agent.extra.tools
     *   - function
     *   - mcp
     *   - gemini: google_search, code_execution, url_context
     *   - openai: mcp, web_search_preview, file_search, image_generation, code_interpreter, computer_use_preview
     *   - anthropic: mcp*, bash, code_execution, computer, str_replace_based_edit_tool, web_search
     *
     * context.tools -> tools + expanded mcp tools
     */

    const mcpServers: Map<string, MCPServer> = new Map();

    let iteration = 0;
    const max_iterations = 10;
    let shouldContinue = true;

    // Basic ReAct algorithm: stop if no tool uses are found.
    while (shouldContinue) {
      iteration++;

      let response: ResponseContext = {};

      try {
        if (iteration > max_iterations) {
          throw new Error("Max LLM iterations reached!");
        }

        // CHECK FOR PENDING PREPROCESSING

        while (org.extra.media_preprocessing?.mode === "active") {
          const pendingPreprocessing = messages.filter(
            (m) =>
              m.content.type === "file" &&
              m.status.pending && // Note: not using status.preprocessing to avoid race conditions with the media preprocessor Edge Function.
              !m.status.preprocessed &&
              +new Date(m.status.pending) >
                +new Date() - MEDIA_PREPROCESSING_TIMEOUT,
          );

          if (!pendingPreprocessing.length) {
            break;
          }

          // WAIT FOR THE PREPROCESSING TO COMPLETE

          log.info(
            `Waiting ${MEDIA_PREPROCESSING_POLLING_INTERVAL}ms for pending preprocessing to complete...`,
          );

          await new Promise((resolve) =>
            setTimeout(resolve, MEDIA_PREPROCESSING_POLLING_INTERVAL)
          );

          // Note: we could check for newer messages here too, but it would bloat the code.

          // RETRIEVE PROCESSED MESSAGES

          const { data: pending_messages } = await client
            .from("messages")
            .select()
            .in(
              "id",
              pendingPreprocessing.map((m) => m.id),
            )
            .throwOnError();

          // Update the messages with the pending processing.
          for (const pm of pending_messages) {
            const index = messages.findIndex((m) => m.id === pm.id);

            if (index > -1) {
              messages[index] = pm;
            }
          }
        }

        // CHECK IF THERE IS A NEWER INCOMING MESSAGE (posterior to the incoming one)

        const { data: new_message } = await client
          .from("messages")
          .select()
          .eq("conversation_id", incoming.conversation_id)
          .eq("direction", "incoming")
          .gt("created_at", incoming.created_at)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle()
          .throwOnError();

        if (new_message) {
          log.info(
            `Newer message ${new_message.id} for conversation ${conv.id} found while processing tool use messages and/or waiting for pending preprocessing. Skipping response.`,
          );

          return new Response("ok", { headers: corsHeaders });
        }

        // MCP SERVERS INITIALIZATION
        // It is here because of multi-agents, which we are not using by the time being.

        const mcpServersToInit = agent.extra.tools?.filter(
          (tool) =>
            tool.provider === "local" &&
            tool.type === "mcp" &&
            !mcpServers.has(tool.label),
        ) || [];

        const mcpServersAux = await Promise.all(
          mcpServersToInit.map((tool) =>
            initMCP(tool as LocalMCPToolConfig, context)
          ),
        );

        mcpServersAux.forEach((mcp) => {
          mcpServers.set(mcp.label, mcp);
        });

        // CURRENT ITERATION TOOLS

        /**
         * Tools to be passed the agent are gruped in two main categories:
         * 1. Local tools
         * 2. External tools
         *
         * Local tools need to be passed to the agent with their input schema.
         * External tools do not require more than their tool config as it comes.
         *
         * We have the following tool types:
         * - `ToolInfo` to tag tool use/result messages with basic tool info (specially `label` and `name`).
         * - `ToolConfig` for agents to declare their tools (`label`, `name` might be unknown for MCP tools and others).
         * - `ToolDefinition`, which as its name suggests, defines the tool (`label` is unknown at definition, only `name`).
         * - `AgentTool`, the combination of config and definition, to be passed to the agent.
         */
        const tools: AgentTool[] = [];

        for (const toolConfig of agent.extra.tools || []) {
          if (toolConfig.provider !== "local") {
            continue;
          }

          switch (toolConfig.type) {
            case "function": {
              const unlabeledTool = Toolbox.function.find(
                (t) => t.name === toolConfig.name,
              );

              if (!unlabeledTool) {
                throw new Error(`Tool ${toolConfig.name} not found.`);
              }

              tools.push(unlabeledTool);

              break;
            }
            case "mcp": {
              const unlabeledTools = mcpServers.get(toolConfig.label)!.tools;

              for (const unlabeledTool of unlabeledTools) {
                const labeledTool = {
                  provider: toolConfig.provider,
                  type: toolConfig.type,
                  label: toolConfig.label,
                  name: unlabeledTool.name,
                  description: unlabeledTool.description,
                  inputSchema: unlabeledTool
                    .inputSchema as z.core.JSONSchema.JSONSchema,
                  outputSchema: unlabeledTool.outputSchema as
                    | z.core.JSONSchema.JSONSchema
                    | undefined,
                  config: toolConfig.config,
                };

                tools.push(labeledTool);
              }

              break;
            }
            case "http":
            case "sql": {
              const unlabeledTools = Toolbox[toolConfig.type];

              for (const unlabeledTool of unlabeledTools) {
                const labeledTool = {
                  ...unlabeledTool,
                  label: toolConfig.label,
                  config: toolConfig.config,
                };

                tools.push(labeledTool);
              }

              break;
            }
          }
        }

        // AGENT CLIENT REQUEST AND RESPONSE

        const handler = ProtocolFactory.getHandler(tools, context, client);

        const agentRequest = await handler.prepareRequest();

        const agentResponse = await handler.sendRequest(agentRequest);

        response = await handler.processResponse(agentResponse);

        if (!response.messages?.length) {
          response.messages = [];
        }

        // TOOL USES AND RESULTS

        const toolUses = response.messages.filter(
          (m) =>
            m.direction === "internal" &&
            m.content.type === "text" &&
            m.content.tool &&
            m.content.tool.provider === "local",
        ) || [];

        for (const row of toolUses) {
          // Only needed to please the TypeScript compiler
          if (
            row.direction !== "internal" ||
            row.content.type !== "text" ||
            !row.content.tool ||
            row.content.tool.provider !== "local"
          ) {
            continue;
          }

          /**
           * # Tool uses and results within parallel tool use
           *
           * Chat Completions API produces a single message with several tool choices.
           * It expects tool results as single messages.
           *
           * On the other hand, Responses API and Messages API also produce a single with several tool uses.
           * But on the contrary, they expect tool results as a single message.
           *
           * Here, the adopted policy is to adhere to the WhatsApp API, this is one message per part.
           * A tool use/result is considered a part.
           */

          let parts: (Part & ToolInfo)[] = [];

          const toolInfo = row.content.tool;

          const agentTool = tools.find(
            (t) =>
              t.provider === toolInfo.provider &&
              t.type === toolInfo.type &&
              ("label" in toolInfo ? t.label === toolInfo.label : true) &&
              t.name === toolInfo.name,
          );

          try {
            if (!agentTool) {
              throw new Error(
                `Tool ${toolInfo.name} not found between available tools.`,
              );
            }

            const ajv = new Ajv2020();
            // Strip $schema since MCP SDK (via Zod) produces draft-07 schemas,
            // but Ajv is imported as the 2020-12 build and rejects unknown drafts.
            // deno-lint-ignore no-explicit-any
            const { $schema: _, ...schema } = agentTool.inputSchema as any;

            const args = JSON.parse(row.content.text);

            // When JSON parsing is done, the message is converted to a data part.
            row.content = {
              version: "1",
              task: row.content.task,
              tool: toolInfo,
              type: "data",
              kind: "data",
              data: args,
            };

            const valid = ajv.validate(schema, args);

            if (!valid) {
              throw new Error(
                `Tool input validation failed: ${JSON.stringify(ajv.errors)}`,
              );
            }

            switch (toolInfo.type) {
              case "custom":
              case "function": {
                const result = await agentTool.implementation(args);

                parts = [
                  {
                    tool: {
                      ...toolInfo,
                      event: "result" as const,
                    },
                    type: "data",
                    kind: "data",
                    data: result,
                  },
                ];

                break;
              }
              case "mcp": {
                const mcp = mcpServers.get(agentTool.label!);

                if (!mcp) {
                  throw new Error(`MCP server ${agentTool.label} not found.`);
                }

                parts = await callTool(mcp, row.content, context, client);

                break;
              }
              case "http":
              case "sql": {
                const result = await agentTool.implementation(
                  args,
                  agentTool.config,
                  context,
                  client,
                );

                const part: DataPart & ToolInfo = {
                  tool: {
                    ...toolInfo,
                    event: "result" as const,
                  },
                  type: "data",
                  kind: "data",
                  data: result,
                };

                parts = [part];

                if (result.file_uri) {
                  part.artifacts = [
                    {
                      type: "file",
                      kind: "document",
                      file: await getFileMetadata(client, result.file_uri),
                    },
                  ];
                }

                break;
              }
            }
          } catch (error) {
            const errorMessage = (error as Error).message || String(error);

            log.warn("Tool error", { tool: toolInfo, error });

            parts = [
              {
                tool: {
                  ...toolInfo,
                  is_error: true,
                  event: "result" as const,
                },
                type: "text",
                kind: "text",
                text: errorMessage,
              },
            ];
          }

          // TODO: Mutating the response object is not the most recommended way to do this
          // but it will be improved soon.
          const taskId = row.content.task?.id || crypto.randomUUID();

          for (const part of parts) {
            const message = part.type === "file"
              ? {
                organization_id,
                service: conv.service,
                organization_address: conv.organization_address,
                contact_address: conv.contact_address,
                direction: "outgoing" as const,
                agent_id: agent.id,
                content: {
                  version: "1" as const,
                  task: { id: taskId },
                  ...part,
                } as OutgoingMessage,
              }
              : {
                organization_id,
                service: conv.service,
                organization_address: conv.organization_address,
                contact_address: conv.contact_address,
                direction: "internal" as const,
                agent_id: agent.id,
                content: {
                  version: "1" as const,
                  task: { id: taskId },
                  ...part,
                } as InternalMessage,
              };

            response.messages.push(message);
          }
        }

        if (!toolUses.length) {
          shouldContinue = false;
        }
      } catch (error) {
        shouldContinue = false;

        log.error("Error in agent client", error as Error);

        response.messages = [
          {
            organization_id,
            service: conv.service,
            organization_address: conv.organization_address,
            contact_address: conv.contact_address,
            direction: org.extra.error_messages_direction || "internal",
            agent_id: agent.id,
            content: {
              version: "1" as const,
              type: "text",
              kind: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          },
        ];
      }

      // STORE CURRENT ITERATION MESSAGES

      if (response.messages?.length) {
        log.info("Agent response", response.messages.at(-1)?.content);

        const output_messages = response.messages.map((message, index) => ({
          ...message,
          // Make sure the messages have the correct organization_address and contact_address
          organization_id: conv.organization_id,
          conversation_id: conv.id,
          organization_address: conv.organization_address,
          contact_address: conv.contact_address,
          // Disambiguate by milliseconds index to ensure the insertion order.
          timestamp: new Date(Date.now() + index).toISOString(),
        }));

        try {
          // Insert and select the inserted messages
          const { data: inserted_messages } = await client
            .from("messages")
            .insert(output_messages)
            .select()
            .order("timestamp")
            .throwOnError();

          // Append generated messages to the context
          messages.push(...inserted_messages);
        } catch (storageError) {
          log.error("Failed to store agent response", storageError as Error);
          shouldContinue = false;
        }
      }
    }

    // TODO: take care of the typing interval corner cases
    clearInterval(typingInterval);

    // STORE RESPONSE

    /*
  if (response?.conversation) {
    const { error } = await client
      .from("conversations")
      .update({
        extra: response.conversation.extra,
      })
      .eq("id", incoming.conversation_id)

    if (error) {
      log.error("Failed to update conversation extra field.", error);
    }
  }

  if (contact && response?.contact) {
    const { error } = await client
      .from("contacts")
      .update({
        extra: response.contact.extra,
      })
      .eq("id", contact.id);

    if (error) {
      log.error("Failed to update contact extra field.", error);
    }
  }
  */

    return new Response(JSON.stringify(messages), {
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    await soltarCandadoConversacion(
      client,
      incoming.conversation_id,
      invocationId,
    );
  }
});
