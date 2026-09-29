/**
 * Control del borrador antes de enviarlo (v28): verificador determinista →
 * juez médico → UNA reescritura si alguno de los dos rechazó → los dos de
 * nuevo sobre la reescritura. Segundo rechazo = silencio (fail-closed).
 *
 * Reparto de trabajo (decisión de Santi 2026-09-29, "el juez solo debería
 * revisar lo médico"):
 *   - `verificador.ts` (código): precios, lista de precios, fechas, horas,
 *     disponibilidad, links, mails, alias/CBU. Exacto y sin opinión.
 *   - juez (LLM): consejo médico, derivación del seguimiento al mail y que lo
 *     que se dice de un tratamiento salga del catálogo.
 * Hasta v27 el juez hacía todo: en 30 días silenció 22 respuestas (17 de
 * turnos, varias correctas) y dejó pasar 18 recomendaciones del tipo "el IPL
 * es perfecto para lo que describís".
 *
 * Vive en su propio módulo porque lo usan `runGuardrail` y el golden set: el
 * golden set tenía su propia copia de este loop y eso ya dio un falso verde
 * (Incidente 13d).
 */

import * as log from "../../_shared/logger.ts";
import {
  callStructured,
  GuardrailLLMError,
  type GuardrailTurn,
  type InfoLlamado,
} from "./anthropic.ts";
import { CALENDLY_LINK, FAQ_OPERATIVA, MAIL_CONSULTAS } from "./catalogo.ts";
import {
  type SalidaJuez,
  type SalidaReescritura,
  SCHEMA_JUEZ,
  SCHEMA_REESCRITURA,
  systemJuezEstatico,
  systemReescrituraContexto,
  systemReescrituraEstatico,
  type TipoRespuesta,
  userJuez,
  userReescritura,
} from "./prompts.ts";
import {
  type Hallazgo,
  motivoDeHallazgos,
  verificarBorrador,
} from "./verificador.ts";

export interface LlamadoControl {
  apiKey: string;
  model?: string;
  headers?: Record<string, string>;
  maxTokens?: number;
}

export interface ControlParams {
  llamado: LlamadoControl;
  catalogo: string;
  /** Evidencia de turnos + jornadas de IPL (texto armado por código). */
  evidencia: string;
  mensajePaciente: string;
  historial: GuardrailTurn[];
  tipo: TipoRespuesta;
  borrador: string;
  ahora?: Date;
  onLlamadoJuez?: (info: InfoLlamado) => void;
  onLlamadoReescritura?: (info: InfoLlamado) => void;
}

/** Quién rechazó y por qué. `hallazgos` solo si fue el verificador. */
export interface Rechazo {
  por: "verificador" | "juez";
  motivo: string;
  hallazgos?: Hallazgo[];
}

export type ResultadoControl =
  | {
    enviar: true;
    mensaje: string;
    reescrito: boolean;
    /** Motivo de aprobación del juez (para el resultado del guardrail). */
    motivo: string;
    primerRechazo?: Rechazo;
  }
  | {
    enviar: false;
    /** Último borrador evaluado (para `agent_respuestas_no_enviadas`). */
    mensaje: string;
    /** Texto para `agent_respuestas_no_enviadas.motivo`. */
    motivoRegistro: string;
    /** Resumen corto para `GuardrailResult.motivo`. */
    motivo: string;
    primerRechazo?: Rechazo;
  };

function detalleError(error: unknown): string {
  return error instanceof GuardrailLLMError ? error.message : String(error);
}

function textoDeTurnos(
  historial: GuardrailTurn[],
  role: "user" | "assistant",
): string {
  return historial
    .filter((t) => t.role === role && typeof t.content === "string")
    .map((t) => t.content as string)
    .join("\n");
}

/**
 * UNA pasada: primero el verificador (gratis, sin red); el juez solo corre
 * si el verificador no encontró nada. `null` = aprobado. Tira
 * `GuardrailLLMError` si falla el llamado al juez.
 */
export async function revisarBorrador(
  params: ControlParams,
  borrador: string,
): Promise<{ rechazo: Rechazo | null; motivoJuez?: string }> {
  const hallazgos = verificarBorrador(borrador, {
    catalogo: params.catalogo,
    faq: FAQ_OPERATIVA,
    evidencia: params.evidencia,
    textoPaciente: [
      textoDeTurnos(params.historial, "user"),
      params.mensajePaciente,
    ].join("\n"),
    textoBotPrevio: textoDeTurnos(params.historial, "assistant"),
    linksPermitidos: [CALENDLY_LINK],
    mailsPermitidos: [MAIL_CONSULTAS],
    ahora: params.ahora ?? new Date(),
  });

  if (hallazgos.length) {
    log.info("Guardrail — verificador", { hallazgos });

    return {
      rechazo: {
        por: "verificador",
        motivo: motivoDeHallazgos(hallazgos),
        hallazgos,
      },
    };
  }

  const juez = await callStructured<SalidaJuez>({
    ...params.llamado,
    system: [systemJuezEstatico(params.catalogo)],
    messages: [{
      role: "user",
      content: userJuez(params.mensajePaciente, params.tipo, borrador),
    }],
    schema: SCHEMA_JUEZ,
    onLlamado: params.onLlamadoJuez,
  });

  log.info("Guardrail — juez", {
    aprobado: juez.aprobado,
    motivo: juez.motivo,
  });

  return juez.aprobado ? { rechazo: null, motivoJuez: juez.motivo } : {
    rechazo: { por: "juez", motivo: juez.motivo },
    motivoJuez: juez.motivo,
  };
}

/** Loop completo: revisión → (una reescritura) → revisión. Nunca tira. */
export async function controlarBorrador(
  params: ControlParams,
): Promise<ResultadoControl> {
  let mensaje = params.borrador;
  let primerRechazo: Rechazo | undefined;

  for (let vuelta = 0; vuelta < 2; vuelta++) {
    let revision;

    try {
      revision = await revisarBorrador(params, mensaje);
    } catch (error) {
      const detalle = detalleError(error);
      log.error("Falló el juez. No se responde nada.", detalle);

      return {
        enviar: false,
        mensaje,
        motivoRegistro: `error técnico en el juez: ${detalle}`,
        motivo: "error en el juez",
        primerRechazo,
      };
    }

    const { rechazo } = revision;

    if (!rechazo) {
      return {
        enviar: true,
        mensaje,
        reescrito: vuelta > 0,
        motivo: revision.motivoJuez ?? "",
        primerRechazo,
      };
    }

    if (vuelta > 0) {
      const motivo =
        `rechazado 2 veces por el ${rechazo.por}: ${rechazo.motivo}`;
      return {
        enviar: false,
        mensaje,
        motivoRegistro: motivo,
        motivo,
        primerRechazo,
      };
    }

    primerRechazo = rechazo;

    let reescritura: SalidaReescritura;

    try {
      reescritura = await callStructured<SalidaReescritura>({
        ...params.llamado,
        system: [
          systemReescrituraEstatico(params.catalogo),
          systemReescrituraContexto(params.evidencia),
        ],
        messages: [{
          role: "user",
          content: userReescritura(
            params.mensajePaciente,
            mensaje,
            rechazo.motivo,
          ),
        }],
        schema: SCHEMA_REESCRITURA,
        onLlamado: params.onLlamadoReescritura,
      });
    } catch (error) {
      const detalle = detalleError(error);
      log.error("Falló la reescritura. No se responde nada.", detalle);

      return {
        enviar: false,
        mensaje,
        motivoRegistro:
          `rechazado por el ${rechazo.por} (${rechazo.motivo}) y falló la reescritura: ${detalle}`,
        motivo: "error en la reescritura",
        primerRechazo,
      };
    }

    if (!reescritura.mensaje?.trim()) {
      return {
        enviar: false,
        mensaje,
        motivoRegistro:
          `rechazado por el ${rechazo.por} (${rechazo.motivo}) y la reescritura vino vacía`,
        motivo: "reescritura vacía",
        primerRechazo,
      };
    }

    log.info("Guardrail — reescritura aplicada", {
      por: rechazo.por,
      motivo: rechazo.motivo,
    });

    mensaje = reescritura.mensaje;
  }

  // Inalcanzable (la segunda vuelta siempre retorna): fail-closed igual.
  return {
    enviar: false,
    mensaje,
    motivoRegistro: "el control del borrador no terminó",
    motivo: "control incompleto",
    primerRechazo,
  };
}
