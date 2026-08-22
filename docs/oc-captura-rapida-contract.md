# Captura rápida de compra — contrato base

## Entidad y alcance

Una captura rápida es una entidad independiente. No es una Solicitud de Compra ni una OC vacía. Hasta su formalización conserva únicamente alcance operativo, observación, estado y referencias a facturas privadas. La captura por sí sola nunca modifica inventario.

QR-1 define exclusivamente el modelo, permisos y contrato futuro. No habilita API, Storage, frontend, formalización ni movimientos.

## Estados y transiciones

Transiciones permitidas:

- NUEVA → BORRADOR.
- BORRADOR → PENDIENTE.
- PENDIENTE → FORMALIZADA.
- PENDIENTE → RECHAZADA.

Transiciones prohibidas:

- BORRADOR → FORMALIZADA.
- BORRADOR → RECHAZADA.
- FORMALIZADA → cualquier estado.
- RECHAZADA → cualquier estado.

BORRADOR no tiene envío ni gestión. PENDIENTE tiene fecha de envío, pero no gestión ni OC. FORMALIZADA tiene gestor, fecha de gestión y una OC. RECHAZADA tiene gestor, fecha de gestión y motivo obligatorio, pero no OC.

## Autorización futura

Permisos definidos:

- `INVENTARIO_OC_CAPTURA_RAPIDA_CREAR`: permite crear y enviar capturas rápidas de compras con factura.
- `INVENTARIO_OC_CAPTURA_RAPIDA_VER`: permite consultar capturas rápidas y sus evidencias.
- `INVENTARIO_OC_CAPTURA_RAPIDA_GESTIONAR`: permite gestionar, rechazar y formalizar capturas rápidas.

Nota técnica: `public.permisos.id_permiso` es una identity `GENERATED ALWAYS`. Las migraciones de este flujo deben permitir que PostgreSQL genere ese ID y nunca insertar IDs manuales, usar `OVERRIDING SYSTEM VALUE` ni manipular su secuencia.

Asignación inicial por nombre normalizado:

- CAJERO y COCINA: CREAR y VER.
- ADMINISTRADOR y SUPER_ADMIN: VER y GESTIONAR.
- ROOT, ADMIN genérico y cualquier otro rol: sin asignación.

Los permisos serán una primera barrera, nunca la única autorización. El backend obtendrá roles efectivos del servidor y aplicará además estas reglas:

- Crear y enviar: CAJERO, COCINA, COCINERO, COCINERA, JEFA_COCINA y JEFE_COCINA.
- Formalizar y rechazar: exclusivamente ADMINISTRADOR y SUPER_ADMIN.
- Un permiso legacy accidental no sustituye la comprobación de rol.

Para Caja/Cocina, el backend obtendrá la sucursal desde el scope del usuario, resolverá el almacén operativo y no confiará en `id_sucursal` enviado por el cliente. El frontend no permitirá seleccionar otra sucursal. Un operativo consultará únicamente sus propias capturas. Administración consultará según el alcance administrativo del módulo.

## Contrato API futuro

Estos endpoints quedan documentados, no implementados:

| Método | Ruta | Contrato |
|---|---|---|
| POST | `/api/solicitudes_compra/capturas-rapidas` | Crea BORRADOR. |
| POST | `/api/solicitudes_compra/capturas-rapidas/:id/evidencias/factura` | Sube una factura por request. |
| DELETE | `/api/solicitudes_compra/capturas-rapidas/:id/evidencias/:id_evidencia` | Elimina evidencia solo en BORRADOR. |
| DELETE | `/api/solicitudes_compra/capturas-rapidas/:id` | Descarta un BORRADOR nunca enviado. |
| PUT | `/api/solicitudes_compra/capturas-rapidas/:id/enviar` | BORRADOR → PENDIENTE; exige al menos una factura activa. |
| GET | `/api/solicitudes_compra/capturas-rapidas` | Listado según scope. |
| GET | `/api/solicitudes_compra/capturas-rapidas/:id` | Detalle según scope. |
| GET | `/api/solicitudes_compra/capturas-rapidas/:id/evidencias` | Facturas privadas mediante URL temporal firmada. |
| PUT | `/api/solicitudes_compra/capturas-rapidas/:id/rechazar` | PENDIENTE → RECHAZADA; motivo obligatorio; solo ADMINISTRADOR/SUPER_ADMIN. |
| POST | `/api/solicitudes_compra/capturas-rapidas/:id/formalizar` | Formalización atómica futura de QR-4; solo ADMINISTRADOR/SUPER_ADMIN. |

## Facturas e inmutabilidad

- Formatos permitidos: JPEG, PNG y WEBP.
- Máximo 6 MB por archivo y 10 imágenes por captura.
- Validar MIME declarado, firma binaria, base64 y nombre sanitizado.
- Storage privado y acceso mediante URL firmada temporalmente.
- Una imagen por request; nunca varias imágenes grandes en un único JSON.
- Reutilizar las garantías de `solicitudesCompraRecepcionService`.

BORRADOR puede agregar o quitar imágenes. PENDIENTE, FORMALIZADA y RECHAZADA son read-only respecto de sus facturas; después del envío no se sustituyen silenciosamente.

Un BORRADOR nunca enviado puede descartarse. El runtime deberá bloquear la captura, comprobar BORRADOR, eliminar relaciones, marcar archivos inactivos, intentar limpiar Storage de forma best-effort y eliminar la captura. Nunca se admite DELETE de PENDIENTE, FORMALIZADA o RECHAZADA. Esto no equivale a eliminar una OC.

## Formalización QR-4

La formalización futura hará `SELECT ... FOR UPDATE` sobre una captura PENDIENTE. Después del lock validará rol administrativo, estado, `id_solicitud_compra IS NULL`, al menos una factura, artículos, asignaciones multi-almacén, unidades/presentaciones, cantidades y proveedor.

Creará directamente una fila en `solicitudes_compra` con:

- `estado = 'RECIBIDA'`.
- `id_sucursal = captura.id_sucursal`.
- `id_almacen = captura.id_almacen`.
- `id_usuario_solicitante = captura.id_usuario_registro`.
- `id_usuario_revisor = administrador que formaliza`.
- `fecha_revision = NOW()`.
- `id_usuario_recepcion = captura.id_usuario_registro`.
- `fecha_recepcion = captura.fecha_envio`.
- `inventario_aplicado = true`.
- `fecha_inventario_aplicado = NOW()`.

En cada línea, `cantidad_solicitada = cantidad_aprobada = cantidad_recibida`. Sus cantidades base también serán iguales y se calcularán con el snapshot real de unidad/presentación. Cada línea tendrá proveedor válido.

Las evidencias reutilizarán el mismo `id_archivo`: se insertará su relación en `solicitudes_compra_evidencias` sin duplicar el objeto de Storage, y la captura conservará su relación original.

La formalización usará el origen existente de Kardex: una `ENTRADA` en `movimientos_inventario` por línea, `ref_origen = 'SOLICITUD_COMPRA'` e `id_ref` igual a la OC definitiva. No se crea un origen nuevo. Una captura PENDIENTE no mueve inventario.

## Idempotencia, concurrencia y rollback

Dos administradores pueden abrir una captura, pero la formalización bloqueará la fila con `SELECT ... FOR UPDATE`. Tras adquirir el lock exigirá PENDIENTE e `id_solicitud_compra IS NULL`. Solo una transacción creará la OC; la segunda recibirá 409. El índice único parcial impide vincular una misma OC a dos capturas. No habrá dos OCs ni inventario doble.

La formalización será todo o nada. Si falla una línea, proveedor, presentación, evidencia, movimiento o actualización final, hará ROLLBACK. La captura seguirá PENDIENTE, `id_solicitud_compra` seguirá NULL y el inventario permanecerá sin cambios.

## Pruebas de escritorio

| # | Caso | Resultado esperado |
|---:|---|---|
| 1 | Caja crea captura. | BORRADOR. |
| 2 | BORRADOR sin factura intenta enviar. | Bloqueado. |
| 3 | BORRADOR con factura envía. | PENDIENTE. |
| 4 | Caja intenta formalizar. | 403. |
| 5 | Cocina intenta formalizar. | 403. |
| 6 | Administrador formaliza. | FORMALIZADA y exactamente una OC. |
| 7 | Super Admin formaliza. | Permitido. |
| 8 | Administrador rechaza PENDIENTE. | RECHAZADA con motivo. |
| 9 | FORMALIZADA intenta rechazarse. | 409. |
| 10 | RECHAZADA intenta formalizarse. | 409. |
| 11 | Dos administradores formalizan simultáneamente. | Una sola OC; la segunda operación recibe 409. |
| 12 | Falla el inventario durante formalización. | ROLLBACK total. |
| 13 | Captura PENDIENTE. | Inventario sin cambios. |
| 14 | Captura FORMALIZADA. | Inventario aplicado exactamente una vez. |
| 15 | Factura formalizada. | Un mismo objeto Storage e `id_archivo` relacionado con captura y OC. |
