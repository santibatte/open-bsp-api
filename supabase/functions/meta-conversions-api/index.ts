// Reports qualified leads (a patient booked a turno via the Calendly link the
// AI agent sent) to Meta's Conversions API, attributed back to the original
// Click-to-WhatsApp ad via `ctwa_clid`. See P05 (proyectos/
// P05_agente_whatsapp_ig_openbsp.md) §3/§4 in the consultorio_dermatologico
// repo for the design rationale.
//
// This is NOT a Meta webhook — it's called by our own systems (the existing
// V0/webapp booking flow, or the Apps Script that watches Calendly) once a
// turno is confirmed, since that's the only place that knows a lead became
// a booking. Auth is a shared bearer secret, same pattern as
// generic-webhook/index.ts.
//
// Contract:
//
//   POST /meta-conversions-api
//   Authorization: Bearer <META_CAPI_WEBHOOK_SECRET>
//   {
//     organization_id: string,
//     contact_address: string,   // bare E.164 digits, matches the WhatsApp
//                                 // contact that OpenBSP already has on file
//     event_name?: string,       // default "Schedule"
//     event_time?: number,       // unix seconds, default: now
//     event_id?: string,         // optional, for Meta-side deduplication
//     value?: number,
//     currency?: string,         // default "ARS"
//   }
//
// Returns { sent: true } on success, { sent: false, reason } when there's
// nothing to attribute (most leads are organic, not from a CTWA ad — that's
// expected, not an error).
//
// NOT VERIFIED AGAINST A LIVE META APP YET. Field names below (action_source,
// messaging_channel, user_data.ctwa_clid, the phone-hashing input format)
// match Meta's public Conversions API docs for Click-to-WhatsApp as of this
// writing, but this endpoint has never been exercised against a real Meta
// Dataset — re-check against
// https://developers.facebook.com/docs/marketing-api/conversions-api
// before the first real send (Fase 2 of P05, blocked on Santi getting the
// Dataset ID + system user token from Events Manager).
import * as log from "../_shared/logger.ts";
import { createUnsecureClient, type Json } from "../_shared/supabase.ts";

const META_API_VERSION = "v24.0"; // matches whatsapp-dispatcher's pinned version
const DATASET_ID = Deno.env.get("META_CAPI_DATASET_ID") ?? "";
const ACCESS_TOKEN = Deno.env.get("META_CAPI_ACCESS_TOKEN") ?? "";
const WEBHOOK_SECRET = Deno.env.get("META_CAPI_WEBHOOK_SECRET") ?? "";

type RequestBody = {
  organization_id: string;
  contact_address: string;
  event_name?: string;
  event_time?: number;
  event_id?: string;
  value?: number;
  currency?: string;
};

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** First inbound message on this contact's conversation that carries a
 * Click-to-WhatsApp referral — Meta only attaches `ctwa_clid` to the message
 * that opened the conversation, not to every message after it. */
async function findCtwaClid(
  client: ReturnType<typeof createUnsecureClient>,
  organizationId: string,
  contactAddress: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("messages")
    .select("content")
    .eq("organization_id", organizationId)
    .eq("contact_address", contactAddress)
    .eq("service", "whatsapp")
    .eq("direction", "incoming")
    .order("timestamp", { ascending: true })
    .limit(20); // referral, if present, is on one of the first few messages

  if (error) {
    log.error("Failed to look up messages for ctwa_clid", { error });
    throw error;
  }

  for (const row of data ?? []) {
    const content = row.content as { referral?: { ctwa_clid?: string } };
    if (content?.referral?.ctwa_clid) return content.referral.ctwa_clid;
  }

  return null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!WEBHOOK_SECRET) {
    log.error("META_CAPI_WEBHOOK_SECRET is not configured");
    return new Response("Not configured", { status: 500 });
  }

  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (token !== WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await req.json()) as Partial<RequestBody>;

  if (!body.organization_id || !body.contact_address) {
    return new Response("organization_id and contact_address are required", {
      status: 400,
    });
  }

  if (!DATASET_ID || !ACCESS_TOKEN) {
    log.error(
      "META_CAPI_DATASET_ID / META_CAPI_ACCESS_TOKEN not configured — see P05 Fase 2.1",
    );
    return new Response("Not configured", { status: 500 });
  }

  const client = createUnsecureClient();

  const ctwaClid = await findCtwaClid(
    client,
    body.organization_id,
    body.contact_address,
  );

  if (!ctwaClid) {
    log.info("No CTWA attribution for this lead — skipping", {
      organization_id: body.organization_id,
      contact_address: body.contact_address,
    });
    return Response.json({ sent: false, reason: "no_ctwa_clid" });
  }

  const hashedPhone = await sha256Hex(body.contact_address);

  const event: Record<string, Json> = {
    event_name: body.event_name ?? "Schedule",
    event_time: body.event_time ?? Math.floor(Date.now() / 1000),
    action_source: "business_messaging",
    messaging_channel: "whatsapp",
    user_data: {
      ctwa_clid: ctwaClid,
      ph: [hashedPhone],
    },
    ...(body.event_id && { event_id: body.event_id }),
    ...(body.value !== undefined && {
      custom_data: {
        value: body.value,
        currency: body.currency ?? "ARS",
      },
    }),
  };

  const capiUrl =
    `https://graph.facebook.com/${META_API_VERSION}/${DATASET_ID}/events`;

  const resp = await fetch(capiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [event],
      access_token: ACCESS_TOKEN,
    }),
  });

  const responseBody = await resp.json().catch(() => null);

  if (!resp.ok) {
    log.error("Meta Conversions API rejected the event", {
      status: resp.status,
      body: responseBody,
      event,
    });

    await client.from("logs").insert({
      organization_id: body.organization_id,
      category: "conversions_api",
      service: "whatsapp",
      level: "error",
      message: "Meta Conversions API rejected the event",
      metadata: { status: resp.status, body: responseBody } as Json,
    });

    return new Response("Meta Conversions API error", { status: 502 });
  }

  log.info("Reported qualified lead to Meta Conversions API", {
    contact_address: body.contact_address,
    event_name: event.event_name,
  });

  await client.from("logs").insert({
    organization_id: body.organization_id,
    category: "conversions_api",
    service: "whatsapp",
    level: "info",
    message: "Reported qualified lead to Meta Conversions API",
    metadata: { event_name: event.event_name } as Json,
  });

  return Response.json({ sent: true });
});
