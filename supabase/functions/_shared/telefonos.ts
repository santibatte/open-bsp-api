/**
 * Normalización de teléfonos al formato canónico del consultorio.
 *
 * Formato canónico (celular argentino, E.164): +549 + código de área + número,
 * sin espacios ni guiones. Ej: +5491158279538 (CABA/AMBA: área 11 + 8 dígitos;
 * interior: áreas de 2-4 dígitos; siempre área+local = 10 dígitos → 13 dígitos
 * después del +).
 *
 * Port 1:1 de `consultorio_dermatologico/recordatorios-cron/api/lib/telefonos.py`
 * (que a su vez espeja `normalizarTelefono()` en `apps_script/WhatsApp.gs`) — si
 * se cambia acá, cambiar también allá. Duplicado a propósito en vez de compartido
 * entre repos/runtimes (mismo criterio que `_extraer_telefono_de_respuestas` en
 * `calendly_tools.py`, que se duplicó en vez de acoplarse a `cron.py`).
 *
 * Reglas:
 *   - Extranjeros (venían con "+" y código de país ≠ 54): se respetan tal cual.
 *   - "0" inicial (prefijo local) y "15" (prefijo celular doméstico) se quitan —
 *     el "15" NUNCA va en formato internacional, lo reemplaza el "9" después del 54.
 *   - Si falta el "9" después del 54 (formato de fijo / como guarda Google Contacts),
 *     se inserta: WhatsApp/Meta lo exige para celulares argentinos, sin él no entrega.
 *   - "9" + área + número sin el 54 (11 dígitos): se antepone 54.
 *   - Sin código de país: se asume Argentina (+549).
 */

/** str/num → "+549..." canónico, "+<cc>..." si es extranjero, o null si no es usable. */
export function normalizarTelefono(
  tel: string | number | null | undefined,
): string | null {
  if (tel === null || tel === undefined) return null;

  const s = String(tel).trim();

  if (!s || s.toLowerCase() === "nan" || s.toLowerCase() === "none") {
    return null;
  }

  const teniaMas = s.startsWith("+");
  let t = s.replace(/\D/g, "");

  if (!t) return null;

  // Extranjero explícito: tenía "+" y no es Argentina → E.164 tal cual.
  if (teniaMas && !t.startsWith("54")) {
    return t.length >= 8 && t.length <= 15 ? "+" + t : null;
  }

  if (t.startsWith("0")) t = t.slice(1);
  if (t.startsWith("15")) t = t.slice(2);

  // Formato doméstico completo "011 15-XXXX-XXXX": el 15 va DESPUÉS del área.
  // área(2-4 díg) + 15 + local = 12 dígitos → se quita el 15 intercalado.
  if (t.length === 12 && !t.startsWith("54")) {
    const m = t.match(/^(\d{2,4})15(\d+)$/);

    if (m && m[1].length + m[2].length === 10) {
      t = m[1] + m[2];
    }
  }

  if (t.startsWith("54")) {
    const resto = t.slice(2);
    t = resto.startsWith("9") ? t : "549" + resto;
  } else if (t.length === 11 && t.startsWith("9")) {
    t = "54" + t; // "9 11 5737 1169": trae el 9 pero le falta el país
  } else {
    t = "549" + t; // local pelado (área + número)
  }

  return t.length >= 12 && t.length <= 14 ? "+" + t : null;
}

export function esExtranjero(telNorm: string | null): boolean {
  return !!telNorm && !telNorm.startsWith("+549");
}

/** El campo `to` de la API de Meta va sin el "+". */
export function paraMetaApi(telNorm: string | null): string | null {
  return telNorm ? telNorm.replace(/^\+/, "") : null;
}
