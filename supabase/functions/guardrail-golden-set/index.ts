/**
 * Golden set del guardrail redactor/juez — Consultorio de la Vampiresa Meli.
 *
 * Pedido explícito de Santi 2026-08-02: antes de decir "esto ya está en
 * prod" tras cambiar los prompts, correr un set fijo de mensajes reales
 * contra el redactor+juez de verdad (mismo código, mismo modelo, mismo
 * catálogo) y revisar los resultados a mano. Reemplaza "probar a ojo con
 * WhatsApp real" por un chequeo repetible.
 *
 * NO toca `public.messages`, `public.contacts` ni ningún contador — no
 * manda nada por WhatsApp, no incrementa offtopic_count. Solo llama a
 * Claude dos veces por caso (igual que `runGuardrail`) y devuelve el
 * resultado. Los casos vienen con `offtopicCount` fijo, no leído de un
 * contacto real.
 *
 * Uso: POST a esta función (con la anon key, igual que cualquier otra acá)
 * y devuelve un JSON con un resultado por caso. Ver
 * `proyectos/P05_lecciones_guardrail.md` (repo `consultorio_dermatologico`)
 * para el historial de qué encontró cada corrida.
 */

import { corsHeaders, errorHandler } from "../_shared/cors.ts";
import { createUnsecureClient } from "../_shared/supabase_client.ts";
import {
  callStructured,
  GuardrailLLMError,
} from "../agent-client/guardrail/anthropic.ts";
import { cargarCatalogo } from "../agent-client/guardrail/catalogo.ts";
import {
  type SalidaJuez,
  type SalidaRedactor,
  SCHEMA_JUEZ,
  SCHEMA_REDACTOR,
  systemJuez,
  systemRedactor,
  userJuez,
  userRedactor,
} from "../agent-client/guardrail/prompts.ts";

// Organización "Vampiresa Meli" — ver project_stack_whatsapp_meta.md.
const ORGANIZATION_ID = "cf231ab1-2432-4d56-baa1-ce900fe7b8b5";

interface CasoGoldenSet {
  id: string;
  descripcion: string;
  mensajePaciente: string;
  offtopicCount: number;
}

/**
 * 9 casos, cubriendo los 8 tipos posibles + 2 regresiones reales encontradas
 * probando en vivo el 2026-08-02 (ver Incidentes 3, 4 y 7 en
 * P05_lecciones_guardrail.md). No es exhaustivo — es un piso mínimo para
 * detectar si un cambio de prompt rompió algo que ya funcionaba.
 */
const GOLDEN_SET: CasoGoldenSet[] = [
  {
    id: "saludo",
    descripcion: "Saludo simple, primera interacción",
    mensajePaciente: "Hola",
    offtopicCount: 0,
  },
  {
    id: "precio_ambiguo",
    descripcion:
      "Precio de un tratamiento con varias formas de aplicación (botox)",
    mensajePaciente: "Hola, cuánto sale el botox?",
    offtopicCount: 0,
  },
  {
    id: "catalogo_variantes",
    descripcion:
      "REGRESIÓN 2026-08-02: NIR sin especificar zona — el juez rechazaba por 'mezclar precios' y por citar reacciones esperables",
    mensajePaciente: "Hola me das info de q es nir ?",
    offtopicCount: 0,
  },
  {
    id: "faq",
    descripcion: "Pregunta operativa (horarios + seña)",
    mensajePaciente:
      "Qué días atienden y necesito seña para reservar el turno?",
    offtopicCount: 0,
  },
  {
    id: "agendar",
    descripcion: "Quiere sacar turno directo, sin preguntar precio",
    mensajePaciente: "Quiero sacar un turno para IPL",
    offtopicCount: 0,
  },
  {
    id: "seguimiento_quemadura",
    descripcion:
      "REGRESIÓN 2026-08-02: reacción a un tratamiento propio, con pedido de opinión sobre una crema",
    mensajePaciente:
      "la doctora me hizo un tratamiento y me salio como una quemadura en la cara, tengo una crema en casa me puedo poner esa?",
    offtopicCount: 0,
  },
  {
    id: "seguimiento_botox",
    descripcion: "Reacción a un tratamiento propio, pidiendo tranquilidad",
    mensajePaciente:
      "Me hice un botox hace 3 días y siento que un párpado me quedó caído, es normal?",
    offtopicCount: 0,
  },
  {
    id: "fuera_de_tema_count0",
    descripcion:
      "Pregunta totalmente ajena, primera vez (debería ser saludo_generico, no fuera_de_tema)",
    mensajePaciente: "Cuánto es 25 por 4?",
    offtopicCount: 0,
  },
  {
    id: "fuera_de_tema_count2",
    descripcion:
      "Pregunta ajena con el contador ya gastado — no debe re-presentarse",
    mensajePaciente: "Vieron el partido de anoche?",
    offtopicCount: 2,
  },
];

interface ResultadoCaso {
  id: string;
  descripcion: string;
  mensajePaciente: string;
  offtopicCount: number;
  tipo?: string;
  mensajeBorrador?: string;
  aprobado?: boolean;
  motivoJuez?: string;
  error?: string;
}

async function correrCaso(
  caso: CasoGoldenSet,
  catalogo: string,
  apiKey: string,
): Promise<ResultadoCaso> {
  const base: ResultadoCaso = {
    id: caso.id,
    descripcion: caso.descripcion,
    mensajePaciente: caso.mensajePaciente,
    offtopicCount: caso.offtopicCount,
  };

  let redactor: SalidaRedactor;

  try {
    redactor = await callStructured<SalidaRedactor>({
      apiKey,
      system: systemRedactor(catalogo, caso.offtopicCount),
      userMessage: userRedactor(caso.mensajePaciente),
      schema: SCHEMA_REDACTOR,
    });
  } catch (error) {
    return {
      ...base,
      error: `redactor: ${
        error instanceof GuardrailLLMError ? error.message : String(error)
      }`,
    };
  }

  if (redactor.tipo === "silencio" || !redactor.mensaje?.trim()) {
    return { ...base, tipo: redactor.tipo, mensajeBorrador: redactor.mensaje };
  }

  let juez: SalidaJuez;

  try {
    juez = await callStructured<SalidaJuez>({
      apiKey,
      system: systemJuez(catalogo, caso.offtopicCount),
      userMessage: userJuez(
        caso.mensajePaciente,
        redactor.tipo,
        redactor.mensaje,
      ),
      schema: SCHEMA_JUEZ,
    });
  } catch (error) {
    return {
      ...base,
      tipo: redactor.tipo,
      mensajeBorrador: redactor.mensaje,
      error: `juez: ${
        error instanceof GuardrailLLMError ? error.message : String(error)
      }`,
    };
  }

  return {
    ...base,
    tipo: redactor.tipo,
    mensajeBorrador: redactor.mensaje,
    aprobado: juez.aprobado,
    motivoJuez: juez.motivo,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");

    if (!apiKey) {
      return Response.json(
        { error: "Falta ANTHROPIC_API_KEY" },
        { status: 500, headers: corsHeaders },
      );
    }

    const client = createUnsecureClient();
    const { texto: catalogo, cantidad } = await cargarCatalogo(
      client,
      ORGANIZATION_ID,
    );

    if (!cantidad) {
      return Response.json(
        { error: "Catálogo vacío — no se puede correr el golden set" },
        { status: 500, headers: corsHeaders },
      );
    }

    const resultados = await Promise.all(
      GOLDEN_SET.map((caso) => correrCaso(caso, catalogo, apiKey)),
    );

    return Response.json({ resultados }, { headers: corsHeaders });
  } catch (err) {
    return errorHandler(err);
  }
});
