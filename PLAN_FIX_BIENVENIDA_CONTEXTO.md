# Plan: mensaje real ignorado por el saludo de bienvenida (+ hallazgos posteriores)

> Encontrado el 2026-08-08 revisando `ARQUITECTURA_AGENTE.md` con Santi (no
> estaba en `AUDITORIA_CODIGO.md` — es un hallazgo posterior).
>
> **✅ ACTUALIZADO 2026-08-09 — Fix 1 y Fix 3 IMPLEMENTADOS** (código en
> `feat/rediseno-guardrail-v2`, sin commitear todavía al escribir esto).
> Fix 2 sigue sin implementar (prioridad más baja, requiere ronda de
> iteración de prompt+golden set con OK de Santi). Además, en la misma
> sesión se resolvieron dos bugs de producción encontrados por separado
> (Problema 1 y Problema 2, ver sección nueva al final) y se agregó una
> nota de mejora futura para el juez (sin implementar, a pedido explícito
> de Santi de solo "anotarla").
>
> **✅ ACTUALIZADO 2026-08-09 (más tarde) — deployado, golden set corrido, y
> arreglado un bug real del HARNESS del golden set (no de producción).**
> `agent-client` y `guardrail-golden-set` deployados a `velvet-agent`
> (`PROMPT_VERSION` 23→24, ver changelog en `prompts.ts`).
>
> Primera corrida (36 casos): 24 aprobados, 9 con `TimeoutError`. En vez de
> aceptar "debe ser rate limit" sin verificar, se confirmó en el código:
> `mockCalendlyTools` nunca toca Calendly real (100% mockeado), así que el
> timeout solo podía venir de Anthropic — cada caso hace hasta 6 llamados
> reales secuenciales, y `guardrail-golden-set/index.ts` corría los 36
> casos con `Promise.all` **sin ningún límite de concurrencia** (100-200+
> requests simultáneos contra la misma cuenta). Los 9 timeouts cayeron
> justo en los casos de `gestion_turno` (más llamados, últimos en la
> secuencia de cada caso). **Fix aplicado al harness:** tandas de
> `CONCURRENCIA_MAX = 6` en vez de todo junto.
>
> Segunda corrida (post-fix): **34/36 aprobados**, 1 rechazo esperado por
> diseño (`juez_rechaza_fecha_inventada`), 1 error técnico distinto y ya
> conocido de antes (`subestado_confirma_datos_guardados`, inestable desde
> el Incidente 14). Detalle completo en `P05_lecciones_guardrail.md`
> (Incidente 16, repo `consultorio_dermatologico`). **Sigue sin commitear**
> el código en `open-bsp-api`. No se sumaron casos nuevos al golden set para
> las situaciones de hoy (bienvenida, turno duplicado, confirmación sin
> agendar) — sigue pendiente.

## Contexto — dos problemas relacionados, no uno solo

**Problema 1 (bug duro, prioridad alta):** cuando el mensaje entrante es el
primero en 24hs (`agent-client/index.ts:504-556`), el código inserta el
saludo de bienvenida (`org.extra.welcome_message`) y hace
`return new Response("ok")` en la línea 555 — **sin llegar nunca al
guardrail**. Si la paciente escribió una pregunta real en ese primer mensaje
("¿tenés lugar el miércoles para un peeling?"), esa pregunta se descarta
para siempre si no vuelve a escribir.

**Problema 2 (diseño frágil, prioridad más baja):** si la paciente SÍ vuelve
a escribir, el modelo tiene la pregunta original disponible en el historial
(`getRecentHistoryTurns`, `index.ts:249-298` — esto **no** se corta por un
mensaje saliente, a diferencia de `getIncomingBurstText`, que sí se corta).
Pero el prompt del redactor (`prompts.ts:921-927`) solo le pide mirar el
historial para no repetir la presentación — no hay ninguna instrucción de
"retomá una pregunta que quedó sin responder". Que el modelo la recupere
sola depende de inferencia, no está garantizado.

Con el Fix 1 aplicado, el escenario más común que dispara el Problema 2
(pregunta real tapada por el saludo) deja de pasar. El Problema 2 sigue
siendo relevante para el caso general de cualquier `silencio` (juez
rechazó dos veces) seguido de un mensaje de seguimiento ambiguo — pero es
una mejora de robustez, no un bug con silencio garantizado.

---

## Fix 1 — no cortar la ejecución después del saludo ✅ IMPLEMENTADO 2026-08-09

**Cambio central:** sacar el `return new Response("ok", ...)` de la línea
555. Dejar que la ejecución siga de largo hacia el resto del pipeline
(`CHECK IF THERE ARE AI AGENTS` → selección de agente → guardrail) usando
el mismo mensaje entrante real.

**Hecho tal cual, sin sorpresas.** Se dejó la decisión de producto de abajo
resuelta por default con la opción (a) — doble saludo aceptado como
cosmético — documentado inline en el código (`index.ts`, dentro del mismo
bloque del saludo). Falta todo lo de la sección "Testing" de abajo: no se
escribió `index_test.ts` ni se sumó caso al golden set — verificado solo
con `deno check`/`lint` (pasan), sin probar contra Claude/Calendly reales
todavía.

**Por qué esto funciona sin más cambios (verificado):** el array `messages`
que usan `getIncomingBurstText`/`getRecentHistoryTurns` más abajo ya se
cargó ANTES de insertar el saludo, y no se vuelve a pedir a la base — así
que el saludo recién insertado no contamina el cálculo de `mensajePaciente`
para esta misma invocación. `mensajePaciente` va a ser el texto real de la
paciente, tal cual.

**Decisión de producto pendiente, no técnica — llevarle a Santi antes de
programar (no decidir solo):** si el primer mensaje real resulta clasificado
como `saludo_generico` (ej. la paciente solo escribió "hola", sin pregunta),
¿mandamos DOS mensajes seguidos —el saludo canned + el saludo redactado por
el modelo— o suprimimos el segundo para no duplicar el saludo? Opciones:
- (a) Aceptar el doble saludo como inofensivo, más simple de implementar.
- (b) Si `tipo === "saludo_generico"` y hubo saludo canned en esta misma
  invocación, no mandar el segundo (solo loguearlo).

**Otros efectos a verificar, no bloqueantes:**
- Costo: cada conversación nueva pasa de "0 llamadas a Claude en el primer
  mensaje" a "2-5 llamadas" — es exactamente el objetivo del fix, pero
  hacerlo explícito para que no sorprenda en `agent_llm_calls`.
- El trigger de pause-on-human-message no se ve afectado — el saludo ya
  inserta con `agent_id` de un agente `ai: true` (ver comentario en
  `index.ts:524-529`), eso no cambia.

**Testing (hoy no existe ningún test para este archivo — gap a cerrar de
paso):**
1. Exportar `getIncomingBurstText`, `getRecentHistoryTurns` e
   `indiceInicioTanda` (hoy son funciones privadas de `index.ts`, sin
   ningún test) y agregar un `index_test.ts` con casos unitarios puros,
   mismo patrón que `prompts_test.ts` (sin red, sin LLM).
2. Caso a cubrir explícitamente: primer mensaje de una conversación nueva
   → `mensajePaciente` es el texto real, `historialTurnos` es `[]` (caso
   límite ya contemplado en `getRecentHistoryTurns:256`, pero sin test
   hoy).
3. Sumar un caso al golden set (o un test de integración liviano) que
   simule: conversación nueva, mensaje real con pregunta puntual → debe
   haber una respuesta real además del saludo (o, si el juez rechaza,
   quedar registrado en `agent_respuestas_no_enviadas` — nunca silencio
   total sin registro).
4. Regresión: confirmar que una conversación YA activa (no dispara el
   bloque de bienvenida) sigue funcionando idéntico — esa rama de código no
   se toca.

**Deploy:** cambio de código puro, `supabase functions deploy agent-client`.
No toca SQL, no requiere correr nada a mano contra la base.

**Documentar al cerrar:** sumar como incidente nuevo en
`proyectos/P05_lecciones_guardrail.md` (repo `consultorio_dermatologico`),
mismo formato que los anteriores.

---

## Fix 2 — reforzar en el prompt que se retomen preguntas pendientes

**Alcance:** agregar una regla al bloque de instrucciones del redactor
(cerca de `prompts.ts:921`, donde ya dice "Mirá el historial antes de
redactar") que le pida: si en el historial reciente hay una pregunta de la
paciente sin respuesta sustantiva (el turno `assistant` que sigue es el
saludo canned, o no hay respuesta después), y el mensaje actual es corto o
ambiguo, interpretar que probablemente se refiere a esa pregunta pendiente
y retomarla.

**Esto es un cambio de prompt, sigue el ciclo ya establecido del proyecto**
(ver memoria `feedback-versionado-prompts-guardrail`): versionar
(`PROMPT_VERSION` 22 → 23), correr el golden set completo ANTES de avisar
que está listo, no perseguir 9/9, documentar en `P05_lecciones_guardrail.md`
con el hash del commit. Sumar 2-3 casos nuevos al golden set que prueben
específicamente este escenario (pregunta real tapada por saludo/silencio +
mensaje de seguimiento ambiguo → debe recuperar el tema).

**Prioridad:** más baja que el Fix 1. Encarar después, y solo si vale la
pena invertir en otra ronda de iteración de prompt (que además requiere el
OK de Santi para entrar al loop de golden set, por el gasto de tokens que
implica iterar).

---

## Fix 3 — avisar (o bloquear) si la paciente ya tiene un turno agendado ✅ IMPLEMENTADO 2026-08-09

**Pedido de Santi (2026-08-08):** antes de agendar un turno nuevo, revisar
si la paciente ya tiene uno agendado, y si es así, decírselo explícitamente
("ah, pero vos ya tenés turno tal día a tal hora") en vez de agendar otro
sin más.

**Estado actual, verificado en código:** el dato YA está disponible — antes
de cada paso de turnos, `guardrail/index.ts:531` llama a
`calendlyTools.consultarTurno(telefono)` y el resultado (`turnosExistentes`)
viaja hasta `ejecutarPasoTurnos` (`turnos.ts:303,981`), que lo formatea como
texto y lo pone en el `system` del modelo vía `contextoAgenteTurnos`
(`prompts.ts:1955-1978`, bloque "TURNOS REALES DE ESTA PACIENTE"). **Pero
es solo informativo:** no hay ninguna instrucción que le pida al modelo
avisar antes de agendar, y `validarGateAgendar` (`turnos.ts:552-644`) —el
gate de código que corre antes de ejecutar `agendar_turno` de verdad— no
chequea `turnosExistentes` en absoluto. Hoy es técnicamente posible que la
paciente termine con dos turnos reales sin que nadie se lo haya avisado —
mismo tipo de gap que el Fix 2 (confiar en que el modelo "se dé cuenta"
solo, sin gate de código que lo garantice).

**Decisión de producto — confirmada por Santi (2026-08-08): no se prohíbe,
se pregunta.** Cuando ya tiene un turno agendado, no se bloquea sin más ni
se agenda directo: se le recuerda a la paciente el turno que ya tiene (día
y hora reales) y se le pregunta si de verdad quiere otro, o si con ese le
alcanza. Recién con una respuesta explícita se avanza (a agendar uno
adicional, o a no hacer nada / redirigir a reprogramar el que ya tiene).
Esto es la opción (b) de las evaluadas — se descartan (a) bloqueo duro sin
preguntar y (c) solo informativo sin gate de código:
- (a) *Bloqueo duro sin preguntar* — descartado: no le da a la paciente la
  chance de decir "sí, quiero otro, es para un tratamiento distinto".
- (b) *Preguntar y confirmar antes de agendar (elegida):* la primera vez
  que se detecta un turno existente, el gate bloquea el `agendar_turno` de
  ESE mensaje y hace que el modelo redacte la pregunta ("ya tenés turno el
  [día] a las [hora] — ¿querés agendar otro además de ese, o con ese estás
  bien?"), usando el texto real de `turnosRealesTexto`, nunca inventado.
  Solo cuando la paciente responde afirmativamente que quiere otro turno,
  se habilita `agendar_turno` de verdad. Reutiliza la misma lógica de
  "escalón de confirmación explícita" que ya existe para
  `lista_para_agendar` → `agendado`.
- (c) *Solo informativo, sin gate* — descartado: depende de que el modelo
  se acuerde de mencionarlo solo, mismo riesgo que hoy.

**Implementación real (distinta del boceto original, más simple):** en vez
de tocar `validarGateAgendar` y depender de que el modelo reporte una
"confirmación explícita" en el schema, se cortó ANTES de llamar a Claude:

1. `ejecutarPasoTurnos` (`turnos.ts`), justo después de calcular
   `turnosRealesTexto` y antes del loop de tools: si
   `subEstado === "lista_para_agendar" && turnosExistentes.length > 0 &&
   !datosGuardados.turnoAdicionalAvisado`, devuelve directo un mensaje
   **armado en código** (nunca por el modelo — cero riesgo de inventar
   fecha/hora) mostrando `turnosRealesTexto` real y preguntando si quiere
   uno adicional o con ese está bien. No gasta ningún llamado a Claude para
   esto.
2. Persistencia nueva en `contacts.extra.turno_adicional_avisado`
   (booleano) vía el mismo RPC genérico de merge jsonb que ya usan
   `email`/`nombre_completo`/`agendamiento_estado` — **cero SQL nuevo**, el
   RPC ya acepta cualquier clave. Funciones nuevas en `guardrail/index.ts`:
   `guardarTurnoAdicionalAvisado` y `resetearTurnoAdicionalAvisado` (esta
   última se dispara junto con el reset de `agendamiento_estado` al arrancar
   un ciclo de agendamiento nuevo).
3. **Limitación conocida, aceptada por ahora:** una vez avisado, CUALQUIER
   mensaje siguiente de la paciente que siga en el flujo de `gestion_turno`
   se interpreta como "sí, quiero el adicional" — no hay una detección real
   de "no, con ese estoy bien" que corte el flujo. Si dice que no, lo más
   probable es que el redactor la saque de `gestion_turno` en su próximo
   mensaje (por contenido), pero no está garantizado por código. Si esto
   importa en la práctica, el siguiente paso sería un campo explícito en
   `SalidaAgenteTurnos` (similar a `afirma_turno_confirmado`, ver Problema 1
   abajo) que capture sí/no explícitamente.
4. **Sin test dedicado todavía** — verificado solo con `deno check`/
   `lint`/`test` (pasan, nada existente se rompió). Pendiente: caso de
   golden set con `turnosExistentes` no vacío en `lista_para_agendar`.

**Prioridad:** alta — a diferencia del Fix 2, acá el riesgo no es "una
pregunta sin responder", es **un turno real duplicado en la agenda de
Meli**.

---

## Orden recomendado

1. Fix 1 (bug duro, silencio garantizado si la paciente no repite el
   mensaje) — prioridad alta, cambio de código simple y acotado. ✅ hecho.
2. Fix 3 (turno duplicado sin avisar) — prioridad alta también. ✅ hecho.
3. Fix 2 (robustez del prompt para retomar preguntas pendientes) —
   prioridad más baja, sigue sin encarar, después, y solo con el OK
   explícito de Santi para la ronda de iteración de prompt+golden set.

---

## Problema 1 — el bot confirmaba turnos que nunca agendaba (alucinación de confirmación) ✅ RESUELTO 2026-08-09

**Reportado con evidencia real de producción** (`turno_acciones`,
`agent_llm_calls`, conversación `f2f066e0-3d5a-4f6f-865e-47d0cf7cde20`,
2026-08-08 22:38hs): el bot escribió "Te agendo peeling para el 20 de
agosto a las 18:00hs con Melisa" sin ningún llamado real a `agendar_turno`
(0 filas en `turno_acciones` para esa franja, y Calendly real no tenía ese
turno).

**Mecanismo:** `calcularSubEstadoParaLlamado` (`turnos.ts:125`) solo
adelanta el sub-estado un escalón, de `confirmando_datos` a
`lista_para_agendar` — acotado a propósito así desde el Incidente 13e (día
y hora tienen que haber pasado por `consultar_disponibilidad` REAL en un
turno anterior antes de llegar a `lista_para_agendar`; no alcanza con "la
paciente lo dijo"). Si el sub-estado se queda en un escalón donde
`agendar_turno` no está expuesto, el modelo queda libre de escribir
cualquier texto, sin ningún gate — y a veces redacta una confirmación
inventada.

**Decisión tomada — NO relajar la máquina de estados** (relajarla para
reconocer saltos de más de un escalón reintroduciría el riesgo exacto que
13e cerró: tratar "la paciente lo dijo" como equivalente a "Calendly lo
confirmó"). En cambio, se agregó la segunda capa de código que ya estaba
acordada como necesaria independientemente del punto anterior:

- Campo nuevo en el schema de salida del paso de turnos:
  `afirma_turno_confirmado: boolean` (`prompts.ts::SalidaAgenteTurnos`/
  `SCHEMA_AGENTE_TURNOS`) — el modelo lo pone en `true` solo cuando
  `mensaje` le dice a la paciente que el turno ya está confirmado.
- `turnos.ts::ejecutarPasoTurnos`, rama `respuesta.kind === "texto"`:
  si `afirma_turno_confirmado === true` pero `agendoDeVerdad === false`
  (no se ejecutó `agendar_turno` con éxito en esta misma llamada), el
  mensaje del modelo se DESCARTA — se manda en su lugar un mensaje fijo
  pidiendo que confirme de nuevo día/horario, se loguea como error, y el
  sub-estado NO avanza (se queda donde estaba, no se resetea de más).
- No depende del prompt para funcionar — es exactamente lo que ya había
  fallado. El chequeo es del código, cruzando un campo estructurado contra
  el estado real de ejecución (`agendoDeVerdad`), mismo patrón que
  `proximoSubEstado` ya usaba para proteger el sub-estado `agendado`.

**Test actualizado:** `prompts_test.ts` (schema `required` incluye el campo
nuevo). Sin test dedicado para la rama de descarte en sí — solo
`deno check`/`lint`/`test` en verde.

---

## Problema 2 — `consultar_disponibilidad` crasheaba y dejaba al bot en silencio ✅ RESUELTO 2026-08-09

**Bug activo en producción al momento del reporte** (4 conversaciones
reales silenciadas entre las 22:53 y las 23:08 del 2026-08-08, filas 55-58
de `agent_respuestas_no_enviadas`).

**Mecanismo:** `_shared/calendly.ts::horariosDisponibles` (línea ~693)
armaba `start_time` como la medianoche LOCAL del día pedido
(`${diaLocalISO}T00:00:00-03:00`). Cuando `diaLocalISO` es "hoy" y ya pasó
la medianoche (es decir, la enorme mayoría del día), ese instante ya quedó
en el pasado → Calendly responde `400: start_time must be in the future` →
el paso de turnos completo explota → fail-closed → silencio total, sin
ningún mensaje de error visible para la paciente.

**Apareció recién el 2026-08-08 porque ese mismo día se sumaron dos
features que arman ventanas que incluyen "hoy"** (búsqueda bidireccional
v21, agendamiento por semana v23) — ninguna se había probado con el reloj
ya avanzado.

**Fix aplicado, el sugerido en el reporte:** `inicio` ahora es
`Math.max(medianocheLocal, ahora)` en vez de la medianoche fija — `fin`
sigue calculándose desde la medianoche (para no angostar la ventana
pedida). Cambio de una función, sin tocar sus 7 call-sites.

**Sin test dedicado** — `calendly.ts` no tiene ningún archivo de test hoy
(gap ya señalado en `AUDITORIA_CODIGO.md`); verificado solo con
`deno check`/`lint`. Recomendado sumar un test unitario para
`horariosDisponibles` con `ahora` mockeado cerca de medianoche, si se llega
a exportar/inyectar el reloj como ya se hace en `turnos.ts`.

---

## Transcripción de audios con Gemini — YA EXISTE, no hacía falta construir nada (descubierto 2026-08-09)

Santi pidió agregar la capacidad de escuchar audios y transcribirlos con
Gemini (free tier), sin conectar la API key todavía, guardando el texto
como anexo del mensaje. **Investigado antes de escribir código nuevo — la
función `media-preprocessor` (`supabase/functions/media-preprocessor/index.ts`,
575 líneas) ya hace exactamente esto, para TODO tipo de media (audio,
imagen, video, documento), no solo audio, y ya está conectada de punta a
punta:**

- **Trigger ya wireado:** `supabase/schemas/03_models/03-05_messages.sql:151-163`
  — cualquier mensaje (entrante o saliente) con `content.type = 'file'`
  dispara `/media-preprocessor` automáticamente vía Postgres trigger, mismo
  mecanismo que usa `agent-client`. Los audios de WhatsApp ya se normalizan
  como `{type: "file", kind: "audio"}` en `whatsapp-webhook/index.ts:326-330`
  — encajan perfecto.
- **Usa Gemini de verdad** (`@google/genai`, ya en las dependencias del
  proyecto) con un prompt específico para audio ("transcripción +
  descripción con reconocimiento de emoción si es voz").
- **Guarda el resultado exactamente como Santi pidió** — como ANEXO del
  mensaje, no reemplazándolo: `content.artifacts: [{ type: "text", kind:
  "transcription", text: "..." }]` en la MISMA fila de `messages`
  (`media-preprocessor/index.ts:525-535`). El tipo `TextPart.kind` en
  `_shared/types/message_types.ts:97` ya incluía `"transcription"` como
  valor válido desde antes — no hizo falta tocar ningún tipo.
- **El "fallback de que el free tier se puede acabar" que Santi pensó que
  quizás era redundante — SÍ es redundante, ya está manejado:** un 429 de
  Gemini se distingue entre rate-limit (reintentable) y quota exhausted
  (`"quota"`/`"RESOURCE_EXHAUSTED"` en el mensaje) — si es quota agotada,
  loguea un warning y NO manda nada al paciente ni rompe nada
  (`media-preprocessor/index.ts:415-427`).
- **Gateado, apagado por defecto:** solo corre si
  `organizations.extra.media_preprocessing.mode === "active"` (hoy la
  organización de Vampiresa/Meli no tiene esto seteado — no se tocó la
  base de datos en esta sesión, sigue inactivo) Y hay una API key
  disponible (`config.api_key` de esa misma config, o el secret
  `GOOGLE_API_KEY` de la función).

**Lo que Santi tiene que hacer cuando quiera activarlo (2 pasos, ninguno es
código):**
1. Conseguir una API key de Gemini (Google AI Studio tiene free tier).
2. Setear en `organizations.extra` de la org de Vampiresa:
   `media_preprocessing: { mode: "active", api_key: "<tu-key>", language: "Spanish" }`.
   **Importante usar `api_key` propio ahí adentro, NO el secret global
   `GOOGLE_API_KEY`** — `billable = !config.api_key` (`media-preprocessor/index.ts:272`):
   si se usa el secret global, la función chequea contra una tabla de
   créditos (`billing.costs`/`billing.ledger`, schema de SaaS multi-tenant
   que probablemente no aplica a este fork de un solo cliente) y puede
   fallar por falta de pricing configurado. Con `api_key` propio se salta
   ese chequeo por completo.

**Lo que esto NO hace, a propósito, y no se tocó:** la transcripción queda
guardada para que un humano la lea en el historial — el guardrail sigue
derivando cualquier mensaje no textual (audio, foto) a
`dra.melisa.altavista@gmail.com` sin mirar la transcripción ni contestar en
base a ella (`guardrail/index.ts`, decisión de diseño ya documentada en
`ARQUITECTURA_AGENTE.md` sección 3). Conectar la transcripción al guardrail
para que el bot LEA y actúe sobre el contenido de un audio de una paciente
es una decisión de producto médica/sensible aparte — no se decidió ni se
construyó acá, hay que hablarlo primero (ver `feedback-colaboracion-tareas-grandes`
en memoria).

---

## Nota para el futuro — el juez debería verificar el turno contra Calendly antes de aprobar (pedido explícito de Santi, SIN IMPLEMENTAR)

Santi pidió dejar anotado, no construir todavía: **el juez no debería poder
aprobar un mensaje que confirma un turno sin que el juez MISMO llame a
Calendly y vea que el turno está ahí de verdad.**

Esto es una capa de defensa más fuerte que la del Problema 1 (que verifica
un booleano de estado LOCAL — `agendoDeVerdad` — dentro del mismo proceso).
Una verificación del juez contra Calendly en vivo cerraría incluso el caso
de que `agendoDeVerdad` esté mal calculado por un bug futuro en
`turnos.ts`, porque no confía en el estado interno del proceso — confía en
la fuente real.

**Costo/complejidad a evaluar antes de construirlo:** hoy el juez NO recibe
el historial ni llama herramientas (decisión de diseño explícita, ver
`project-guardrail-redactor-juez` en memoria) — agregarle una llamada real
a Calendly le suma latencia (otro round-trip HTTP) y una nueva superficie
de fallo (¿qué hace el juez si Calendly no responde justo en ese momento?
— probablemente rechazar fail-closed, pero hay que decidirlo explícito).
Evaluar si conviene en el juez mismo o como un chequeo de código aparte
justo antes de enviar cualquier mensaje con `afirma_turno_confirmado: true`
(más simple: una consulta a `consultarTurno` ya existente, sin tocar el
prompt del juez en absoluto).

---

## Problemas de contexto/memoria de estado observados en una conversación real (2026-08-08, sin resolver — necesita investigación con golden set, no un parche a ciegas)

Santi pasó una conversación real de WhatsApp (mesoterapia facial, 20:21 a
20:36hs) con varios síntomas de que el modelo no está usando bien el
contexto durante el agendamiento:

1. Pide "mesoterapia facial" y agendar el 30/08 a la tarde → el bot
   pregunta "¿cuál tratamiento facial te interesa?" — como si no hubiera
   leído "mesoterapia facial" dos mensajes atrás.
2. Corregido ("pero te dije mesoterapia facial"), el bot pide disculpas
   pero en vez de ofrecer horarios manda el link genérico de Calendly —
   contradictorio con lo que después SÍ hace (ofrecer horarios reales).
3. Vuelve a preguntar "¿qué tratamiento te interesa?" una tercera vez.
4. Cuando finalmente ofrece horarios, la paciente elige uno y dice su
   "horario preferido" — el bot se los vuelve a repetir en vez de confirmar
   el elegido, y recién ahí (sin que se lo pidan de nuevo) pide mail/nombre.
5. Al final pide cancelar un turno recién agendado (se resuelve bien, con
   link real) y después pregunta "¿tengo algún turno agendado?" — sin
   respuesta visible en la transcripción pegada por Santi.

**Por qué esto NO se toca con un parche rápido ahora:**
- El historial (`getRecentHistoryTurns`, últimos 10 mensajes) sí viaja
  como turnos reales al modelo — el dato "mesoterapia facial" debería estar
  ahí. Si se pierde, hay varias causas posibles no excluyentes: la ventana
  de 10 mensajes se comió el mensaje original por el ida-y-vuelta de
  clarificaciones, el prompt del paso de turnos no insiste lo suficiente en
  "repasá TODO el historial antes de preguntar de nuevo", o son artefactos
  de la inconsistencia de LLM ya documentada en el proyecto (Incidentes
  2/8/9 — mismo prompt, resultados distintos entre corridas).
- Sin poder reproducir esto contra un golden set (con el mismo mensaje
  exacto, corriendo varias veces), cualquier cambio de prompt corre el
  riesgo de "arreglar" este caso puntual y romper otro — exactamente el
  patrón de v6→v7→v8 documentado en `P05_lecciones_guardrail.md`, que llevó
  a la política actual de "no perseguir cada incidente aislado" (ver
  `feedback-versionado-prompts-guardrail`).

**Qué hacer antes de tocar el prompt por esto:**
1. Sumar 3-4 casos al golden set que repliquen esta conversación paso a
   paso (tratamiento mencionado 2+ mensajes atrás, horario preferido ya
   dado, pedido de "¿tengo turno agendado?").
2. Correrlos varias veces contra el prompt actual para ver si el problema
   es sistemático o es la inconsistencia ya conocida del LLM.
3. Recién con esa evidencia, decidir si hace falta reforzar el prompt (y
   qué tan agresivamente) o si el problema real es la ventana de historial
   (en cuyo caso la solución sería persistir el tratamiento detectado en
   `contacts.extra`, igual que ya se hace con `email`/`nombre_completo` —
   ver Fix 3 arriba para el mismo patrón de persistencia).
4. El punto 5 (pregunta "¿tengo turno agendado?" sin respuesta) puede ser
   directamente el Problema 2 de arriba (ya resuelto) si esa conversación
   coincidió con la ventana en que `consultar_disponibilidad` estaba
   crasheando — revisar `agent_llm_calls`/`agent_respuestas_no_enviadas`
   para esa conversación puntual antes de asumir que es un bug nuevo y
   distinto.
