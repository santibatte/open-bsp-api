/**
 * ARCHIVO TEMPORAL — prueba manual de agendar + consultar + cancelar un
 * turno real de Calendly, pedida por Santi 2026-08-05 para validar la
 * lógica de `recordatorios-cron/api/lib/calendly_tools.py` (Python) antes
 * de confiar en ella. Reimplementado acá en TS solo porque desde acá se
 * puede invocar sin pelear con el Deployment Protection de Vercel — la
 * lógica real que se va a usar es la de calendly_tools.py, no esta.
 *
 * BORRAR este archivo (y la función deployada) apenas termine la prueba.
 */
import { corsHeaders, errorHandler } from "../_shared/cors.ts";

const CALENDLY_API_BASE = "https://api.calendly.com";
const TEL_PRUEBA_WSP = "1158219804"; // Santi, sin 549 (formato de la pregunta custom)
const EMAIL_PRUEBA = "santiagobattezzati@gmail.com";
const NOMBRE_PRUEBA = "PRUEBA CLAUDE - borrar";

function headers() {
  const apiKey = Deno.env.get("CALENDLY_API_KEY");
  if (!apiKey) throw new Error("Falta CALENDLY_API_KEY");
  return {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function userUri(): Promise<string> {
  const r = await fetch(`${CALENDLY_API_BASE}/users/me`, {
    headers: headers(),
  });
  if (!r.ok) throw new Error(`users/me ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.resource.uri;
}

async function eventTypeUri(nombre: string): Promise<string> {
  const uri = await userUri();
  const r = await fetch(
    `${CALENDLY_API_BASE}/event_types?user=${
      encodeURIComponent(uri)
    }&active=true&count=100`,
    { headers: headers() },
  );
  if (!r.ok) throw new Error(`event_types ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const nombres = data.collection.map((e: { name: string; active: boolean }) =>
    `${e.name} (active=${e.active})`
  );
  const et = data.collection.find((e: { name: string }) => e.name === nombre);
  if (!et) {
    throw new Error(
      `No se encontró event type '${nombre}'. Encontrados: ${
        JSON.stringify(nombres)
      }`,
    );
  }
  return et.uri;
}

async function eventTypeDetalle(eventTypeUriStr: string) {
  const uuid = eventTypeUriStr.split("/").pop();
  const r = await fetch(`${CALENDLY_API_BASE}/event_types/${uuid}`, {
    headers: headers(),
  });
  if (!r.ok) {
    throw new Error(`event_types/{uuid} ${r.status}: ${await r.text()}`);
  }
  const data = await r.json();
  return data.resource;
}

async function primerHorarioLibre(eventTypeUriStr: string): Promise<string> {
  const ahora = new Date();
  for (let dia = 1; dia <= 30; dia += 6) {
    const inicio = new Date(ahora.getTime() + dia * 86400000);
    const fin = new Date(inicio.getTime() + 6 * 86400000);
    const params = new URLSearchParams({
      event_type: eventTypeUriStr,
      start_time: inicio.toISOString().slice(0, 19) + "Z",
      end_time: fin.toISOString().slice(0, 19) + "Z",
    });
    const r = await fetch(
      `${CALENDLY_API_BASE}/event_type_available_times?${params}`,
      {
        headers: headers(),
      },
    );
    if (!r.ok) {
      throw new Error(`available_times ${r.status}: ${await r.text()}`);
    }
    const data = await r.json();
    if (data.collection?.length > 0) return data.collection[0].start_time;
  }
  throw new Error("No se encontró ningún horario disponible en 30 días");
}

async function agendar(eventTypeUriStr: string, startTime: string) {
  const r = await fetch(`${CALENDLY_API_BASE}/invitees`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      event_type: eventTypeUriStr,
      start_time: startTime,
      invitee: {
        name: NOMBRE_PRUEBA,
        email: EMAIL_PRUEBA,
        timezone: "America/Argentina/Buenos_Aires",
      },
      event: {
        location_configuration: {
          kind: "physical",
          location: "Uruguay 1061 4to 57, Recoleta, CABA",
        },
      },
      questions_and_answers: [
        {
          question: "Número de teléfono del invitado",
          answer: TEL_PRUEBA_WSP,
          position: 0,
        },
      ],
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    throw new Error(`invitees POST ${r.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function cancelar(eventUuid: string, motivo: string) {
  const r = await fetch(
    `${CALENDLY_API_BASE}/scheduled_events/${eventUuid}/cancellation`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ reason: motivo }),
    },
  );
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`cancellation POST ${r.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function invitees(eventUuid: string) {
  const r = await fetch(
    `${CALENDLY_API_BASE}/scheduled_events/${eventUuid}/invitees`,
    {
      headers: headers(),
    },
  );
  if (!r.ok) throw new Error(`invitees GET ${r.status}: ${await r.text()}`);
  return await r.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  const pasos: Record<string, unknown> = {};
  try {
    const etUri = await eventTypeUri(
      "Turno Dermatología - Dra. Melisa Altavista",
    );
    pasos.event_type_uri = etUri;
    pasos.event_type_detalle = await eventTypeDetalle(etUri);

    const startTime = await primerHorarioLibre(etUri);
    pasos.slot_elegido = startTime;

    const resAgendar = await agendar(etUri, startTime);
    pasos.agendar = resAgendar;

    const eventUri: string = resAgendar.resource.event;
    const eventUuid = eventUri.split("/").pop()!;
    pasos.event_uuid = eventUuid;

    // Esperar un instante a que Calendly propague antes de consultar.
    await new Promise((res) => setTimeout(res, 1500));

    pasos.consultar_antes_de_cancelar = await invitees(eventUuid);

    pasos.cancelar = await cancelar(
      eventUuid,
      "Prueba técnica automática — no es un turno real",
    );

    return Response.json(pasos, { headers: corsHeaders });
  } catch (err) {
    pasos.error = String(err);
    return Response.json(pasos, { status: 500, headers: corsHeaders });
  }
});
