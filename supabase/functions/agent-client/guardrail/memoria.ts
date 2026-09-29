/**
 * Memoria de largo plazo de la paciente (etapa, sub-estado de agendamiento,
 * mail, nombre, último turno consultado...) — DÓNDE se lee y se escribe.
 *
 * Bug real 2026-09-29 (Mariya Popova): hasta acá todo se guardaba SOLO en
 * `contacts.extra`, y cada escritura arrancaba con `if (!contact?.id)
 * return;`. Una paciente nueva no tiene fila en `contacts` (la agenda
 * sincronizada de Meli; ~150 números del consultorio estaban así), así que
 * NADA sobrevivía entre mensajes: el sub-estado volvía siempre a
 * `recolectando_horario`, `agendar_turno` nunca se exponía, el modelo
 * "confirmaba" igual y el fail-closed de turnos.ts la metía en un loop de
 * "Perdón, todavía no pude confirmar tu turno". También re-pedía el mail.
 *
 * Fix: si no hay contacto, la memoria vive en `contacts_addresses.extra` (una
 * fila por teléfono, existe siempre que hay conversación). NO se crea un
 * contacto a propósito: `contacts` es la agenda que ve el consultorio y
 * llenarla con cada número desconocido la ensucia. El trigger `set_extra`
 * (`merge_update`) de esa tabla ya mergea el patch con lo existente, igual
 * que en `contacts`, así que no hace falta SQL nuevo. `manage_contact_on_
 * address_sync` solo actúa si el patch trae `synced` — nunca es el caso acá.
 *
 * Si la paciente tiene contacto, se usa SOLO el contacto (comportamiento de
 * siempre). Lo que haya quedado en la dirección antes de vincularla a un
 * contacto no se migra — como mucho repite un escalón del agendamiento.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../../_shared/logger.ts";
import type { ContactAddressRow, ContactRow } from "../../_shared/supabase.ts";

type DestinoMemoria =
  | { tipo: "contacto"; contactId: string }
  | {
    tipo: "direccion";
    organizationId: string;
    service: ContactAddressRow["service"];
    address: string;
  };

export interface MemoriaPaciente {
  /** Lo guardado hasta este mensaje. Se actualiza en memoria con cada
   * `guardarEnMemoria` para que lecturas posteriores del mismo mensaje lo
   * vean. */
  extra: Record<string, unknown>;
  /** `null` = no hay dónde persistir (golden set, conversación rara sin
   * dirección) — las escrituras son no-op, igual que antes. */
  destino: DestinoMemoria | null;
}

export function crearMemoriaPaciente(
  contact: ContactRow | undefined,
  contactAddress: ContactAddressRow | null | undefined,
): MemoriaPaciente {
  if (contact?.id) {
    return {
      extra: { ...(contact.extra as Record<string, unknown> | null ?? {}) },
      destino: { tipo: "contacto", contactId: contact.id },
    };
  }

  if (contactAddress?.address) {
    return {
      extra: {
        ...(contactAddress.extra as Record<string, unknown> | null ?? {}),
      },
      destino: {
        tipo: "direccion",
        organizationId: contactAddress.organization_id,
        service: contactAddress.service,
        address: contactAddress.address,
      },
    };
  }

  return { extra: {}, destino: null };
}

/**
 * Mergea `patch` en la memoria de la paciente. Best effort: si falla se
 * loguea y se sigue (mismo criterio que tenía cada guardado por separado).
 * Ojo con valores objeto: el merge de la base es PROFUNDO (`merge_update`),
 * así que un objeto se tiene que escribir siempre con todas sus claves.
 */
export async function guardarEnMemoria(
  client: SupabaseClient,
  memoria: MemoriaPaciente | undefined,
  patch: Record<string, unknown>,
  que: string,
): Promise<void> {
  if (!memoria?.destino || !Object.keys(patch).length) return;

  Object.assign(memoria.extra, patch);

  const destino = memoria.destino;

  const { error } = destino.tipo === "contacto"
    ? await client.rpc("merge_contact_datos_contacto", {
      _contact_id: destino.contactId,
      _datos: patch,
    })
    : await client
      .from("contacts_addresses")
      .update({ extra: patch })
      .eq("organization_id", destino.organizationId)
      .eq("service", destino.service)
      .eq("address", destino.address);

  if (error) {
    log.error(
      `Guardrail — no se pudo guardar en la memoria de la paciente (${que}, destino ${destino.tipo}); se ignora`,
      error,
    );
  }
}
