/**
 * Único punto por el que un mail "crudo" (tipeado por la paciente, guardado
 * en `contacts.extra`, o cualquier otra fuente) se convierte en un mail
 * validado para usar en el resto del guardrail — en particular, la búsqueda
 * de turnos por mail en Calendly (`calendly.ts::consultarTurno`).
 *
 * Incidente 2026-08-10 (Maria Ines Cerdá, ver P05_lecciones_guardrail.md):
 * `consultarTurno` nunca chequeaba si el mail que le pasaban era `""` — no
 * causó el bug de ese incidente directamente (ver `emailEfectivo` en
 * `agent-client/guardrail/turnos.ts`), pero auditando el camino apareció
 * como un hueco real: nada impedía pasar un string vacío o mal formado como
 * si fuera un mail válido. `EmailValidado` lo cierra a nivel de tipos, no
 * solo con un `if` que hay que acordarse de poner en cada lugar nuevo que
 * toque mails.
 */
import { z } from "zod";

const EmailSchema = z.string().trim().toLowerCase().email();

/** Tipo nominal — solo se construye vía `parsearEmailOpcional`. */
export type EmailValidado = string & { readonly __brand: "EmailValidado" };

/**
 * `null`/`undefined`/`""`/espacios en blanco/mail mal formado → `null`.
 * Cualquier otro caso → mail normalizado (trim + lowercase).
 */
export function parsearEmailOpcional(
  raw: string | null | undefined,
): EmailValidado | null {
  if (!raw) return null;

  const resultado = EmailSchema.safeParse(raw);

  return resultado.success ? (resultado.data as EmailValidado) : null;
}
