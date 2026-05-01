REGLAS DE NEGOCIO, SEGURIDAD Y CALIDAD TECNICA
Proyecto: Jonnys / Jonnys SmartOrder
Modulo foco: Ventas, Inventario, Cocina, Pedidos, Cierres de Caja, Reversiones, Descuentos y Ticket termico
Version: 1.0

USO RECOMENDADO:
Este documento debe usarse como referencia obligatoria para Codex o cualquier IA de desarrollo antes de modificar codigo, base de datos, endpoints, componentes de frontend o flujos operativos.


============================================================
1. PROPOSITO DEL DOCUMENTO
============================================================

Este documento consolida las reglas de negocio, criterios tecnicos, controles de seguridad y lineamientos de calidad definidos para el modulo de Ventas y sus integraciones en Jonnys SmartOrder.

Reglas generales:
- No modificar codigo sin verificar primero la estructura real del proyecto.
- No asumir nombres de columnas, roles, permisos, endpoints ni tablas.
- No declarar algo como terminado si no fue implementado y verificado.
- No confiar en validaciones del frontend para reglas criticas.
- Toda regla sensible debe aplicarse en backend.
- El codigo debe ser eficiente, escalable, auditable y seguro.


============================================================
2. CONTEXTO GENERAL DEL SISTEMA
============================================================

Jonnys SmartOrder es un sistema web full-stack para operacion de restaurante/ventas, con modulos como:

- Ventas.
- Pedidos.
- Cocina.
- Caja y cierres de caja.
- Inventario.
- Sucursales.
- Personas/clientes/empleados.
- Seguridad, roles y permisos.
- Fidelizacion.
- Descuentos.
- Menu publico.
- Planillas.

El sistema tiene frontend React/Vite y backend Node.js/Express con base de datos PostgreSQL/Supabase.

El modulo de Ventas debe integrarse correctamente con:
- Inventario.
- Cocina.
- Pedidos.
- Caja.
- Cierres de caja.
- Fidelizacion.
- Seguridad.
- Descuentos.
- Impresion de ticket/factura.


============================================================
3. PRINCIPIOS OBLIGATORIOS DE DESARROLLO
============================================================

3.1. Principio de verdad en backend
- El backend debe recalcular totales, descuentos, impuestos, inventario, estado de pedidos y movimientos de caja.
- El frontend puede mostrar calculos preliminares, pero no debe ser fuente de verdad.

3.2. No borrar operaciones financieras
- Una venta/factura no debe eliminarse fisicamente.
- Una reversion no debe borrar ni editar la factura original.
- Toda correccion financiera debe hacerse mediante movimientos compensatorios, documentos de reversion y auditoria.

3.3. Transaccionalidad
Toda operacion critica debe ejecutarse dentro de una transaccion:
- Crear venta.
- Confirmar pago.
- Facturar pedido.
- Crear reversion.
- Rebajar inventario.
- Registrar faltante.
- Aplicar descuento.
- Afectar caja.
- Revertir puntos de fidelizacion.

3.4. Idempotencia
Deben evitarse duplicaciones por doble clic, reintentos del navegador, peticiones paralelas o errores de red.

Casos criticos:
- Doble venta.
- Doble confirmacion de pago.
- Doble facturacion.
- Doble reversion.
- Doble rebaja de inventario.
- Doble aplicacion de descuento.
- Doble envio de correo.

3.5. Auditoria obligatoria
Toda accion sensible debe guardar:
- Usuario.
- Rol.
- Sucursal.
- Caja.
- Sesion de caja.
- Fecha/hora.
- IP.
- User-Agent.
- Dispositivo si esta disponible.
- Accion ejecutada.
- Entidad afectada.
- Motivo cuando aplique.
- Estado anterior y nuevo cuando aplique.

3.6. No exposicion de errores internos
El backend nunca debe exponer al cliente:
- Stack traces.
- SQL crudo.
- Mensajes internos de PostgreSQL.
- Detalles de conexion.
- Variables de entorno.
- Rutas internas del servidor.
- Informacion de librerias o versiones sensibles.

La respuesta al cliente debe ser controlada, por ejemplo:
{
  "success": false,
  "code": "INTERNAL_ERROR",
  "message": "No se pudo completar la operacion."
}

El detalle tecnico debe quedar solo en logs seguros del servidor.


============================================================
4. REGLAS DE INVENTARIO Y COCINA
============================================================

4.1. Rebaja de inventario
- Cuando se vende una receta, deben rebajarse los insumos y productos terminados que formen parte de esa receta.
- Cuando se vende un combo, el combo puede contener recetas y productos simples.
- Los combos pueden afectar inventario de recetas, productos terminados o ambos.
- Todo pedido debe generar entrada en cocina, incluso si incluye productos directos.
- El inventario debe rebajarse cuando cocina marque el pedido como preparado/listo.
- El inventario debe rebajarse aunque el pedido este pendiente de entrega, siempre que ya fue preparado/listo.

4.2. Estado de cocina
Cuando cocina marque un pedido como preparado/listo:
- El sistema debe descontar inventario.
- Si el descuento se registra correctamente, el pedido debe pasar automaticamente a LISTO_ENTREGA.
- En frontend, debe aparecer en el recuadro o columna "Listos para entrega".

4.3. Stock por sucursal
- El stock debe manejarse por sucursal.
- Cada producto o insumo pertenece a un unico almacen.
- No se debe asumir multi-almacen salvo que se redisene explicitamente.

4.4. Stock insuficiente
Si no hay stock suficiente al preparar un pedido:
- El sistema NO debe bloquear la operacion de cocina.
- Debe permitir completar la preparacion.
- Debe permitir stock negativo de forma auditada.
- Debe registrar un movimiento tipo FALTANTE_COCINA.
- El faltante debe poder consultarse despues en inventario/reportes.
- El pedido debe pasar a LISTO_ENTREGA.

4.5. Cancelacion antes de preparar
Si un pedido se cancela antes de ser preparado:
- Debe devolver/liberar inventario automaticamente si existia reserva o movimiento previo.
- Si la venta/pedido ya estaba confirmado, no usar rollback de base de datos despues del commit; usar movimiento compensatorio.

4.6. Reversion despues de preparado
Si un pedido ya fue preparado y luego se revierte:
- No se deben devolver insumos de recetas o combos al inventario.
- Solo debe afectar caja.
- Si hay producto terminado y aplica devolucion, ese producto si puede volver al inventario.

4.7. Movimientos recomendados
- SALIDA_PREPARACION.
- ENTRADA_CANCELACION.
- FALTANTE_COCINA.
- ENTRADA_REV_PRODUCTO_TERMINADO.
- AJUSTE_INVENTARIO.


============================================================
5. REGLAS DE VENTAS Y FACTURACION
============================================================

5.1. Codigo de venta
- El formato visible debe conservarse como VTA-00001.
- El codigo VTA debe guardarse en base de datos.
- No debe generarse solo en frontend.
- No debe calcularse dinamicamente unicamente con id_factura.
- Debe persistirse como dato historico.

5.2. Alcance del correlativo
- El correlativo de venta debe ser por sucursal.
- Debe reiniciarse diariamente.
- El reinicio diario debe basarse en la zona horaria local de Honduras.
- Usar zona horaria: America/Tegucigalpa.
- Debe ser consistente aunque el servidor use UTC.

5.3. Concurrencia
- Dos ventas simultaneas no deben generar el mismo VTA.
- El correlativo debe generarse dentro de transaccion.
- Debe usarse bloqueo transaccional, por ejemplo SELECT ... FOR UPDATE o mecanismo equivalente.

5.4. Preparacion para CAI/SAR
- El sistema debe dejar preparada la estructura para soportar facturacion CAI autorizada en el futuro.
- Por ahora no se cuenta con integracion fiscal CAI/SAR.
- El rango inicial debe ser 0 a 0.
- No se debe simular facturacion fiscal real.
- Separar el codigo operativo interno de campos fiscales futuros.

Campos conceptuales recomendados:
- codigo_venta: VTA-00001.
- numero_documento_fiscal: NULL por ahora.
- cai: NULL por ahora.
- rango_autorizado_desde: 0.
- rango_autorizado_hasta: 0.
- modo_fiscal: INTERNO / CAI_PREPARADO / CAI_ACTIVO.

5.5. Creacion de factura desde pedido
- Los pedidos del menu publico deben crear factura hasta que el cajero, administrador o super admin confirme el pago.
- Debe evitarse doble confirmacion cuando dos usuarios confirman al mismo tiempo.
- Debe mostrarse mensaje de confirmacion antes de facturar.
- La facturacion debe ser por orden de llegada y con bloqueo/idempotencia.


============================================================
6. REGLAS DE PEDIDOS
============================================================

6.1. Pedidos visibles en la pestana Pedidos
Deben aparecer todos:
- Pedidos del menu publico.
- Pedidos creados desde caja.
- Pedidos de delivery.
- Otros pedidos operativos.

6.2. Estados definitivos
Estados recomendados:
- PENDIENTE_PAGO.
- PAGO_CONFIRMADO.
- EN_COCINA.
- EN_PREPARACION.
- LISTO_ENTREGA.
- ENTREGADO.
- CANCELADO.

6.3. Flujo de pago
- Un pedido entra a cocina despues de confirmar pago.
- El pago puede ser por transferencia por ahora.
- No debe subirse comprobante de pago.
- Debe registrarse banco.
- Debe registrarse codigo de transaccion.
- Debe validarse que el codigo de transaccion no se reutilice indebidamente.

6.4. Confirmacion de pago
Pueden confirmar pago:
- Cajero.
- Administrador.
- Super admin.

6.5. Timeout
- Si el pago no se confirma en 10 minutos, el pedido debe cancelarse automaticamente o quedar marcado como cancelado por timeout.
- La cancelacion debe ser auditable.

6.6. Edicion y cancelacion
- Un pedido confirmado no se puede editar.
- Un pedido que ya esta en EN_PREPARACION no se puede cancelar.
- Un pedido listo pero no entregado debe seguir visible para auditoria.
- Al completar pedido, debe cerrarse automaticamente en ventas.

6.7. Cocina
- Cocina tiene su propio modulo.
- Cocina debe ver el nombre del cliente como actualmente.
- Cocina no debe ver historial de ventas completo.
- La pestana Pedidos de Ventas esta pensada para cajero/administracion, no para cocina.

6.8. Vista Kanban
La pestana Pedidos debe funcionar como tablero Kanban por estado:
- PENDIENTE_PAGO.
- PAGO_CONFIRMADO.
- EN_COCINA.
- EN_PREPARACION.
- LISTO_ENTREGA.
- ENTREGADO.
- CANCELADO.


============================================================
7. REGLAS DE HISTORIAL DE VENTAS Y PERMISOS
============================================================

7.1. Acceso completo
Solo pueden ver historial completo:
- Super admin.
- Admin.
- Administrador.
- Gerente de sucursal si en el sistema equivale a administrador.

Codex debe verificar los nombres reales de roles en la base de datos mediante MCP o consulta equivalente.

7.2. Alcance por sucursal
- Incluso los administradores deben ver solo las sucursales asignadas.
- No se debe asumir acceso global a todas las sucursales.
- El filtro debe aplicarse en backend.

7.3. Cajero y roles operativos
El cajero debe ver:
- Ventas de su sucursal.
- Solo de las ultimas 72 horas exactas.

Otros roles con acceso al historial, si no son admin/super admin:
- Deben limitarse a ultimas 72 horas exactas.
- Deben limitarse a su alcance de sucursal.

7.4. Regla de tiempo
- El historial limitado debe calcularse como ultimas 72 horas exactas.
- No usar hoy + 3 dias calendario para el historial limitado.
- Ejemplo correcto:
  fecha_hora_facturacion >= now() - interval '72 hours'

7.5. Backend obligatorio
- El frontend puede ocultar datos, pero no es suficiente.
- El backend debe aplicar filtros por rol, permiso, sucursal y tiempo.

7.6. Permisos separados
Debe existir permiso separado para:
- Ver historial completo.
- Ver historial limitado.
- Exportar ventas antiguas.
- Imprimir ventas antiguas.
- Registrar reversion.
- Aplicar descuento.
- Crear descuento.
- Confirmar pago.


============================================================
8. REGLAS DE PAGINACION Y TABLA DE VENTAS
============================================================

8.1. Paginacion real
- El endpoint GET /ventas debe paginar en servidor.
- No cargar todo el historial y paginar solo en frontend.
- Debe aceptar page y pageSize.
- Debe devolver total y totalPages.

Respuesta recomendada:
{
  "data": [],
  "pagination": {
    "page": 1,
    "pageSize": 10,
    "total": 250,
    "totalPages": 25
  }
}

8.2. Vista de cards y tabla
- Debe conservarse la vista de cards.
- Puede existir tambien vista de tabla.
- La paginacion debe funcionar en ambas vistas.
- La barra de paginacion debe asemejarse al modulo de Seguridad, pero adaptada visualmente al modulo de Ventas.

8.3. Filtros
Filtros recomendados:
- Busqueda.
- Estado.
- Fecha desde.
- Fecha hasta.
- Sucursal.
- Cajero.
- Metodo de pago.
- Codigo VTA.
- Cliente.


============================================================
9. REGLAS DE TICKET TERMICO / FACTURA IMPRESA
============================================================

9.1. Formato
- No se debe imprimir el modal completo.
- No debe imprimirse el layout del dashboard.
- No debe imprimirse menu inferior ni navegacion.
- Debe existir componente dedicado de ticket.

9.2. Anchos configurables
El sistema debe permitir configurar:
- 58 mm.
- 80 mm.

9.3. Impresion inicial
- Por ahora la impresion debe ser manual para pruebas.
- No activar impresion automatica todavia.
- A futuro se podra habilitar impresion automatica.

9.4. Navegador o app local
Fase inicial:
- Usar navegador con CSS de impresion.

Fase futura:
- Evaluar app local/conector ESC/POS para Epson.
- Esto permitira mejor control sobre corte de papel, apertura de gaveta e impresion automatica real.

9.5. Logo
- El logo debe mostrarse por defecto.
- Debe poder desactivarse para ahorrar papel.

9.6. Datos obligatorios del ticket
Debe mostrar:
- JONNY'S WINGS.
- Direccion si esta configurada.
- Telefono si esta configurado.
- Codigo de venta VTA-00001.
- Fecha y hora.
- Cliente.
- RTN si el cliente lo proporciona.
- Consumidor final por defecto si no hay nombre.
- Cajero/usuario.
- Caja.
- Sesion de caja.
- Sucursal.
- Metodo de pago.
- Items.
- Cantidad.
- Descripcion.
- Precio unitario.
- Subtotal.
- Descuento si aplica.
- ISV 15% si aplica.
- ISV 18% si aplica.
- Exento si aplica.
- Exonerado si aplica.
- Total.
- Efectivo entregado si aplica.
- Cambio si aplica.
- Mensaje final.

9.7. Copia de cocina
- No imprimir copia para cocina por defecto.
- Cocina usara pantalla/modulo propio.
- A futuro podria configurarse impresion de comanda por sucursal.

9.8. Ticket de reversion
No debe verse como factura normal.
Debe decir claramente:
- COMPROBANTE DE REVERSIÓN.
- REV-00001.
- Referencia a VTA original.
- Motivo.
- Cajero.
- Caja actual.
- Caja original.
- Monto reversado.
- Lineas reversadas.
- Fecha/hora.
- Sucursal.
- Mensaje de control/auditoria.


============================================================
10. REGLAS DE REVERSIÓN DE VENTAS
============================================================

10.1. Boton
Agregar boton:
- "Registrar reversion"
Debe estar junto al boton:
- "Nueva venta"

10.2. Quien puede revertir
- El cajero puede registrar reversion.
- Tambien admin y super admin si tienen permiso.
- No requiere autorizacion de otro usuario.
- Debe existir permiso especifico para reversion.

10.3. Tiempo maximo
- Una venta solo puede revertirse dentro de 1 hora despues de registrada.
- Pasada 1 hora, bloquear reversion normal.
- Si se requiere reversion tardia, debe tratarse como flujo administrativo futuro.

10.4. Caja
- Si la caja original esta abierta, la reversion puede afectar esa caja.
- Si la caja original esta cerrada, la reversion afecta la caja actual abierta.
- Siempre debe guardar referencia a la caja original.
- Si no hay caja actual abierta, bloquear reversion.
- La reversion debe aparecer en cierres de caja como movimiento de reversion/egreso/ajuste, segun el modelo final.

10.5. Reversion total
Ejemplo:
Venta VTA-00062:
- 2 hamburguesas.
- 1 hot dog.
Total: L 390.

Reversion total:
- Se reversan todas las lineas pendientes de reversar.
- Se genera REV-00001.
- La venta queda marcada como REVERTIDA_TOTAL.
- No se borra la factura original.

10.6. Reversion parcial
Ejemplo:
Venta VTA-00062:
- 2 hamburguesas.
- 1 hot dog.

Reversion parcial:
- Se reversa solo 1 hamburguesa.
- Se genera REV-00001.
- La venta queda como REVERTIDA_PARCIAL.
- El resto de la venta sigue valida.

10.7. Limites de reversion
- No permitir revertir una reversion.
- No permitir doble reversion de la misma cantidad/linea.
- No permitir reversar mas cantidad que la vendida.
- No permitir reversion si no hay caja actual abierta.
- No modificar los totales originales de la factura.

10.8. Motivos validos
- ERROR_DIGITACION.
- CLIENTE_CANCELO.
- PRODUCTO_NO_DISPONIBLE.
- DEVOLUCION.
- COBRO_INCORRECTO.
- OTRO.

10.9. Observacion
- No debe ser obligatoria.
- Puede ser opcional.

10.10. Fidelizacion
- Una venta revertida debe revertir puntos de fidelizacion relacionados.
- Debe hacerse de manera auditada y transaccional.

10.11. Inventario en reversion
- Solo devolver inventario si es producto terminado.
- No devolver insumos de recetas o combos ya preparados.
- Si la reversion ocurre antes de preparacion, usar flujo de cancelacion/liberacion correspondiente.

10.12. Correo de reversion
Debe enviarse correo a:
- gersonmz@jonnyshn.com

Enviar correo cuando:
- Reversion exitosa.
- Reversion fallida por regla de negocio.
- Reversion fallida por error tecnico.

Pero solo si:
- El usuario esta autenticado.
- La peticion paso controles basicos de seguridad.
- No se trata de un ataque anonimo o spam automatizado.

No enviar correo cuando:
- No hay sesion valida.
- Falla CSRF.
- No hay autenticacion.
- Es spam de rutas inexistentes.
- Es ataque automatizado evidente.

10.13. Datos del correo
El correo debe incluir:
- Resultado: exitosa o fallida.
- Codigo REV si existe.
- Codigo VTA original.
- Usuario/cajero.
- Sucursal.
- Caja actual.
- Caja original.
- Motivo.
- Monto.
- Fecha/hora.
- IP.
- User-Agent.
- Error controlado si fallo.

10.14. Auditoria de reversion
Debe guardar:
- IP.
- User-Agent.
- Dispositivo si esta disponible.
- Usuario.
- Rol.
- Sucursal.
- Caja actual.
- Caja original.
- Fecha/hora.
- Tipo de reversion.
- Motivo.
- Lineas reversadas.
- Monto reversado.
- Estado del correo.


============================================================
11. REGLAS DE DESCUENTOS
============================================================

11.1. Tipos permitidos
- Porcentaje.
- Cortesia.
- Cliente frecuente.

11.2. Quien crea descuentos
Solo:
- Super admin.
- Administrador.

11.3. Quien aplica descuentos
Pueden aplicar descuentos existentes:
- Cajero.
- Administrador.
- Super admin.

11.4. Limite del cajero
- El cajero no define descuentos libres.
- El cajero solo elige descuentos creados previamente por admin/super admin.
- No se requiere limite maximo adicional si el descuento ya fue configurado por administracion.

11.5. Nivel de aplicacion
Se soportan dos niveles:
- Descuento global a nivel factura.
- Descuento por linea/producto/detalle.

11.6. Restriccion critica
- No se permite combinar descuento global y descuento por linea en la misma factura.
- Un producto/linea no puede tener mas de un descuento.
- Debe validarse en backend.

11.7. Orden de aplicacion
- El descuento global se aplica antes.
- El descuento por linea aplica a la linea especifica.
- Como no se permite combinar ambos, el backend debe bloquear intentos mixtos.

11.8. ISV y descuentos
Se indico que el descuento por linea no se aplica antes del ISV.
Sin embargo, para evitar problemas fiscales, el sistema debe dejar parametrizable la base de calculo:
- ANTES_ISV.
- DESPUES_ISV.

El valor final debe validarse con el responsable contable/fiscal de Jonnys.

11.9. Motivo
- El descuento debe guardar motivo obligatorio.
- El motivo debe estar preconfigurado por administrador o super admin.

11.10. Autorizacion
Debe guardar:
- Quien creo el descuento.
- Quien aplico el descuento.
- Quien autorizo el descuento si el modelo lo separa.
- Fecha/hora de aplicacion.

11.11. Restricciones
Los descuentos deben poder restringirse por:
- Sucursal.
- Fecha de vigencia.
- Estado activo/inactivo.

No se requiere restriccion por rol.

11.12. Aplica a
Los descuentos aplican a:
- Productos.
- Recetas.
- Combos.

11.13. Ticket
- El descuento debe aparecer en el ticket.
- Si es por linea, debe mostrarse linea por linea.
- Si es global, debe mostrarse como descuento general.
- Como no se permite mezclar, el ticket debe reflejar claramente un solo tipo de descuento.


============================================================
12. REGLAS DE CAJA Y CIERRES
============================================================

12.1. Relacion con ventas
Toda venta debe relacionarse con:
- Caja.
- Sesion de caja.
- Usuario/cajero.
- Sucursal.

12.2. Relacion con reversion
Toda reversion debe:
- Afectar caja actual abierta.
- Referenciar caja original.
- Referenciar sesion de caja original.
- Guardar sesion de caja actual.
- Reflejarse en cierres de caja.

12.3. Caja cerrada
- No modificar cierres historicos.
- Si la venta original pertenece a caja cerrada, la reversion se registra en caja actual.
- Debe quedar referencia cruzada para auditoria.

12.4. Cierre de caja
Los cierres deben poder mostrar:
- Ventas.
- Reversiones.
- Diferencias.
- Movimientos de caja.
- Incidencias.
- Ajustes.
- Usuario responsable.
- Sesion.


============================================================
13. SEGURIDAD INFORMATICA OBLIGATORIA
============================================================

13.1. Estandares base
El codigo debe alinearse con principios vigentes de:
- OWASP Top 10.
- OWASP ASVS.
- Defensa en profundidad.
- Principio de minimo privilegio.
- Seguridad por defecto.
- Validacion en servidor.
- Auditoria trazable.

13.2. Autenticacion
- Toda ruta sensible debe requerir sesion valida.
- No confiar en datos de usuario enviados por frontend.
- Validar sesion activa en backend.
- No permitir operaciones criticas con usuario deshabilitado.
- No permitir operaciones criticas si la sesion fue revocada.

13.3. Autorizacion
- Autenticacion no es suficiente.
- Cada accion sensible requiere permiso explicito.
- El backend debe validar permisos, no solo el frontend.
- No usar unicamente ocultamiento visual de botones.
- Verificar sucursales asignadas.
- Verificar caja/sesion asociada.
- Verificar rol y permiso.

13.4. CSRF
- Operaciones POST, PUT, PATCH y DELETE deben validar CSRF.
- No desactivar CSRF para ventas, reversion, descuentos, caja o pedidos.
- Cookies de sesion deben ser HttpOnly.
- Cookies deben usar Secure en produccion.
- Cookies deben usar SameSite adecuado segun despliegue.

13.5. SQL Injection
Prohibido:
- Concatenar strings SQL con datos de usuario.
- Armar WHERE dinamico sin parametros.
- Insertar directamente search, sort, idSucursal, estado, fechas o filtros.

Obligatorio:
- Usar consultas parametrizadas.
- Validar tipos antes de llegar al SQL.
- Usar listas blancas para columnas ordenables.
- Usar listas blancas para estados y enums.
- Rechazar filtros desconocidos.
- Validar limites de pageSize.

Ejemplo incorrecto:
SELECT * FROM ventas WHERE cliente = '${cliente}'

Ejemplo correcto:
SELECT * FROM ventas WHERE cliente = $1

13.6. XSS / inyeccion de script
- Escapar o sanear todo texto que se renderice desde base de datos.
- No usar dangerouslySetInnerHTML salvo necesidad extrema y sanitizacion robusta.
- No insertar HTML proveniente del cliente en tickets, nombres, observaciones o motivos.
- Validar nombres de cliente, RTN, banco, codigo de transaccion y observaciones.
- Sanitizar mensajes antes de enviarlos a vistas.
- No permitir scripts en campos de texto.

Campos especialmente sensibles:
- Nombre de cliente.
- Observacion.
- Motivo.
- Codigo de transaccion.
- Banco.
- Direccion.
- Descripcion de producto.
- Nombre de descuento.

13.7. Validacion de entrada
Toda entrada debe validarse en backend:
- Tipos.
- Rangos.
- Longitudes.
- Formato.
- Requeridos.
- Enums.
- IDs existentes.
- Pertenencia a sucursal.
- Estado permitido para transicion.

Rechazar:
- IDs negativos.
- IDs no numericos.
- Montos negativos no permitidos.
- Cantidades cero o negativas, salvo reversion controlada.
- Fechas invalidas.
- Estados no definidos.
- pageSize excesivo.
- Texto demasiado largo.
- Caracteres de control.

13.8. Rate limiting
Aplicar limites especiales a:
- Login.
- Registro.
- Recuperacion de contrasena.
- Confirmacion de pago.
- Registro de reversion.
- Aplicacion de descuentos.
- Exportacion de ventas.
- Impresion de ventas antiguas.
- Envio de correos.

Evitar que un usuario o bot provoque:
- Spam de correos.
- Saturacion de la base de datos.
- Doble reversion.
- Fuerza bruta.
- Enumeracion de datos.

13.9. Manejo de errores
No exponer:
- err.stack.
- err.message crudo si contiene detalles internos.
- SQL.
- Nombre de tablas internas.
- Nombre de columnas internas.
- Detalles de conexion.
- Tokens.
- Secrets.
- Rutas absolutas del servidor.

Registrar internamente:
- Codigo de error.
- Trace interno.
- Request ID.
- Usuario.
- IP.
- Ruta.
- Timestamp.
- Datos seguros de contexto.

13.10. Logs
- No guardar contrasenas.
- No guardar tokens completos.
- No guardar cookies.
- No guardar secretos.
- No guardar datos sensibles innecesarios.
- Enmascarar credenciales.
- No versionar logs.
- No incluir logs en zips de entrega.

13.11. Archivos sensibles
No incluir en repositorio:
- .env.
- Logs.
- Tokens temporales.
- Backups con credenciales.
- Dumps productivos con datos sensibles.
- Scripts con passwords hardcoded.
- Archivos de prueba con claves reales.

13.12. CORS
- No usar origin "*".
- Definir origenes explicitos.
- En produccion, permitir solo dominios oficiales.
- En desarrollo, permitir unicamente localhost/puertos conocidos.
- Mantener credentials solo si es necesario y correctamente configurado.

13.13. Seguridad de cookies y sesion
- Sesion en cookie HttpOnly.
- Secure en produccion.
- SameSite configurado.
- Expiracion razonable.
- Revocacion de sesion.
- Validacion de sesion activa.
- No exponer JWT en localStorage si se usa cookie HttpOnly.

13.14. Proteccion contra abuso de correos
- Correos de reversion fallida solo para intentos autenticados y con controles minimos superados.
- No enviar correo por cada intento anonimo.
- Agregar deduplicacion o cooldown si un usuario provoca muchas fallas.
- Registrar alerta interna.

13.15. Seguridad en impresion
- El ticket debe renderizar datos persistidos, no datos temporales manipulables del frontend.
- No imprimir datos no confirmados.
- No permitir inyeccion HTML en ticket.
- No imprimir errores tecnicos.
- No mostrar informacion interna de sistema.

13.16. Seguridad en reportes/exportacion
- Exportar requiere permiso explicito.
- Imprimir ventas antiguas requiere permiso explicito.
- El backend debe filtrar por sucursal y rol.
- No exportar mas datos de los permitidos.
- Limitar tamano de exportaciones.
- Auditar exportaciones.

13.17. Seguridad en descuentos
- El cajero no puede crear descuentos libres.
- El backend valida descuento activo, vigente y de la sucursal.
- No aceptar monto de descuento calculado por frontend.
- Guardar quien aplica y quien autoriza.
- Bloquear combinaciones prohibidas.

13.18. Seguridad en reversion
- Validar permiso.
- Validar plazo de 1 hora.
- Validar caja abierta.
- Validar sucursal asignada.
- Validar que la venta no este totalmente revertida.
- Validar cantidad disponible para reversar.
- Evitar doble reversion con bloqueo transaccional.
- Auditar IP y dispositivo.
- Enviar correo controlado.

13.19. Seguridad en pedidos
- Confirmacion de pago requiere permiso.
- Codigo de transferencia debe validarse.
- Evitar doble confirmacion.
- Evitar doble facturacion.
- Bloquear edicion tras confirmacion.
- Bloquear cancelacion en EN_PREPARACION.
- Aplicar timeout de 10 minutos.

13.20. Seguridad en inventario
- Rebaja de inventario debe ser transaccional.
- Usar bloqueo al afectar stock.
- Registrar faltantes.
- No ocultar stock negativo.
- No permitir ajuste manual sin permiso.
- Auditar ajustes.


============================================================
14. EFICIENCIA, ESCALABILIDAD Y CALIDAD DE CODIGO
============================================================

14.1. Eficiencia backend
- Usar paginacion en servidor para ventas y pedidos.
- Evitar traer todo y filtrar en frontend.
- Usar indices para filtros frecuentes.
- Evitar consultas N+1.
- Agrupar lecturas relacionadas.
- Usar transacciones cortas.
- No mantener locks mas tiempo del necesario.
- Liberar clientes del pool PostgreSQL.
- No abrir conexiones innecesarias.
- Manejar timeouts.

14.2. Indices recomendados
Evaluar indices para:
- facturas.codigo_venta.
- facturas.fecha_hora_facturacion.
- facturas.id_sucursal.
- facturas.id_usuario.
- facturas.id_sesion_caja.
- pedidos.estado.
- pedidos.fecha_creacion.
- pedidos.id_sucursal.
- movimientos_inventario.id_sucursal.
- movimientos_inventario.ref_origen.
- facturas_reversiones.codigo_reversion.
- facturas_reversiones.id_factura_original.
- facturas_reversiones.creada_en.

14.3. Escalabilidad funcional
El diseno debe soportar:
- Varias sucursales.
- Varios cajeros simultaneos.
- Varias ventas simultaneas.
- Pedidos publicos concurrentes.
- Correlativos diarios por sucursal.
- Diferentes anchos de ticket.
- Futuro CAI/SAR.
- Futuro conector de impresion local.
- Futuro delivery.
- Futuro control avanzado de reportes.

14.4. Calidad frontend
- Componentes pequenos y reutilizables.
- Separar logica de negocio de componentes visuales.
- Usar hooks para estado complejo.
- No duplicar calculos criticos.
- No guardar logica fiscal critica solo en frontend.
- Manejar loading, error y empty states.
- Evitar renderizados innecesarios.
- Evitar modales gigantes con demasiada responsabilidad.
- Crear componente dedicado para ticket.

14.5. Calidad backend
- Separar routers, services y repositories cuando sea necesario.
- No dejar logica compleja dentro del router si puede moverse a service.
- Validar payloads con esquema.
- Centralizar manejo de errores.
- Centralizar generacion de correlativos.
- Centralizar calculo de totales.
- Centralizar validacion de permisos.
- Centralizar registro de auditoria.

14.6. Mantenibilidad
- Nombrar funciones de forma clara.
- Evitar archivos demasiado grandes.
- Documentar reglas de negocio no obvias.
- Usar constantes para estados.
- Usar enums o catalogos para motivos.
- No usar strings magicos repartidos.
- Evitar duplicar logica entre venta, pedido y reversion.

14.7. Pruebas minimas
Agregar pruebas o verificaciones para:
- Crear venta.
- Generar VTA concurrente.
- Confirmar pago.
- Evitar doble confirmacion.
- Enviar pedido a cocina.
- Marcar preparado/listo.
- Registrar FALTANTE_COCINA.
- Reversion total.
- Reversion parcial.
- Evitar doble reversion.
- Reversion con caja cerrada.
- Correo de reversion exitosa.
- Correo de reversion fallida autenticada.
- Descuento global.
- Descuento por linea.
- Bloqueo de descuento combinado.
- Historial limitado para cajero.
- Historial completo solo admin/super admin.
- Ticket 58mm.
- Ticket 80mm.

14.8. Respuestas API
Usar respuestas consistentes:
{
  "success": true,
  "data": {},
  "message": "Operacion completada."
}

Errores:
{
  "success": false,
  "code": "VALIDATION_ERROR",
  "message": "Datos invalidos."
}

No mezclar formatos sin necesidad.

14.9. Performance frontend
- No renderizar miles de ventas.
- Usar paginacion.
- Usar filtros con debounce en busqueda.
- Usar estados de carga.
- Evitar recalcular listas grandes en cada render.
- Mantener vista de cards, pero con datos paginados.
- Usar componentes memoizados solo donde aporte valor real.

14.10. Migraciones
- Toda modificacion de base de datos debe hacerse con script SQL versionado.
- El script debe ser idempotente cuando sea posible.
- Debe incluir verificacion previa.
- Debe evitar DROP destructivo sin respaldo.
- Debe documentar cambios.
- Debe actualizar constraints, indices y relaciones.


============================================================
15. ESTRUCTURA DE BASE DE DATOS RECOMENDADA
============================================================

15.1. Configuracion de facturacion por sucursal
Tabla conceptual:
facturacion_config_sucursal

Campos recomendados:
- id_config.
- id_sucursal.
- prefijo_venta.
- prefijo_reversion.
- longitud_correlativo.
- reinicio_diario.
- modo_fiscal.
- mostrar_logo_ticket.
- ancho_ticket_mm.
- activo.
- creado_en.
- actualizado_en.

15.2. Correlativos diarios
Tabla conceptual:
facturacion_correlativos_diarios

Campos recomendados:
- id_correlativo.
- id_sucursal.
- fecha_operacion.
- tipo_documento: VENTA / REVERSION.
- prefijo.
- ultimo_numero.
- creado_en.
- actualizado_en.

Constraint:
- UNIQUE(id_sucursal, fecha_operacion, tipo_documento).

15.3. Rangos CAI futuros
Tabla conceptual:
facturacion_rangos_cai

Campos recomendados:
- id_rango_cai.
- id_sucursal.
- cai.
- numero_desde.
- numero_hasta.
- fecha_limite_emision.
- estado: BORRADOR / ACTIVO / VENCIDO / AGOTADO.
- creado_por.
- creado_en.

Inicialmente:
- numero_desde = 0.
- numero_hasta = 0.
- estado = BORRADOR.

15.4. Reversiones
Tabla conceptual:
facturas_reversiones

Campos recomendados:
- id_reversion.
- codigo_reversion.
- id_factura_original.
- id_sucursal.
- id_caja_original.
- id_sesion_caja_original.
- id_caja_actual.
- id_sesion_caja_actual.
- tipo_reversion: PARCIAL / TOTAL.
- motivo.
- monto_reversado.
- estado.
- creada_por.
- creada_en.
- ip_origen.
- dispositivo.
- user_agent.
- correo_notificado.
- notificado_en.

15.5. Detalle de reversion
Tabla conceptual:
facturas_reversiones_detalle

Campos recomendados:
- id_reversion_detalle.
- id_reversion.
- id_detalle_factura.
- tipo_item: PRODUCTO / RECETA / COMBO.
- id_producto.
- id_receta.
- id_combo.
- cantidad_revertida.
- precio_unitario_original.
- subtotal_revertido.
- isv_15_revertido.
- isv_18_revertido.
- total_revertido.
- devuelve_inventario.

15.6. Pagos por transferencia
Tabla conceptual:
pedidos_pagos_transferencia

Campos recomendados:
- id_pago_transferencia.
- id_pedido.
- banco.
- codigo_transaccion.
- confirmado_por.
- confirmado_en.
- estado.

Constraint recomendado:
- UNIQUE(banco, codigo_transaccion).

15.7. Descuentos
Tabla catalogo conceptual:
descuentos

Campos recomendados:
- id_descuento.
- nombre.
- tipo_descuento: PORCENTAJE / CORTESIA / CLIENTE_FRECUENTE.
- valor.
- nivel_aplicacion: FACTURA / LINEA.
- id_sucursal.
- fecha_inicio.
- fecha_fin.
- motivo_preconfigurado.
- activo.
- creado_por.
- creado_en.

Tabla de aplicacion:
facturas_descuentos

Campos recomendados:
- id_factura_descuento.
- id_factura.
- id_detalle_factura nullable.
- id_descuento.
- nivel_aplicacion.
- monto_aplicado.
- autorizado_por.
- aplicado_por.
- motivo.
- creado_en.


============================================================
16. ENDPOINTS RECOMENDADOS
============================================================

16.1. Ventas
GET /ventas?page=1&pageSize=10&search=&fechaDesde=&fechaHasta=&idSucursal=&estado=
POST /ventas
GET /ventas/:id
POST /ventas/:id/reversiones
GET /ventas/:id/reversiones

16.2. Pedidos
GET /ventas/pedidos?estado=&page=&pageSize=
POST /ventas/pedidos/:id/confirmar-pago
POST /ventas/pedidos/:id/cancelar
POST /ventas/pedidos/:id/facturar

16.3. Descuentos
GET /ventas/descuentos
POST /ventas/descuentos
PATCH /ventas/descuentos/:id
POST /ventas/:id/descuentos

16.4. Configuracion de ticket
GET /ventas/ticket-config
PATCH /ventas/ticket-config

16.5. Cocina
PATCH /cocina/pedidos/:id/preparado
PATCH /cocina/pedidos/:id/listo


============================================================
17. CRITERIOS DE ACEPTACION
============================================================

Codex solo debe considerar terminada una fase si cumple los criterios correspondientes.

17.1. Correlativos
- Dos ventas simultaneas no generan el mismo codigo.
- Dos reversiones simultaneas no generan el mismo codigo.
- VTA se guarda en base de datos.
- REV se guarda en base de datos.
- Se reinicia por sucursal y fecha local Honduras.

17.2. Historial
- Cajero no puede ver mas de 72 horas.
- Cajero solo ve ventas de su sucursal.
- Admin/super admin solo ven sucursales asignadas.
- El filtro se aplica en backend.
- Exportar/imprimir ventas antiguas requiere permiso separado.

17.3. Ticket
- No imprime modal completo.
- No imprime dashboard.
- Soporta 58mm y 80mm.
- Muestra JONNY'S WINGS.
- Muestra cajero/caja/sesion.
- Muestra ISV/exento/exonerado si aplica.
- Muestra descuento si aplica.
- Ticket de reversion se identifica claramente como reversion.

17.4. Inventario
- Al marcar listo/preparado se descuenta inventario.
- Si falta stock, permite stock negativo auditado.
- Registra FALTANTE_COCINA.
- Pedido pasa a LISTO_ENTREGA.
- Cancelacion antes de preparar compensa/libera.
- Reversion despues de preparado no devuelve insumos de receta/combo.

17.5. Reversion
- Boton "Registrar reversion" existe.
- Reversion total funciona.
- Reversion parcial funciona.
- Plazo maximo de 1 hora.
- Caja actual abierta obligatoria.
- Referencia caja original.
- No borra factura original.
- No permite revertir reversion.
- No permite doble reversion.
- Envia correo en exito.
- Envia correo en fallo autenticado.
- Audita IP/dispositivo/user-agent.

17.6. Pedidos
- Vista Kanban por estado.
- Confirmacion de pago por usuario autorizado.
- Timeout de 10 minutos.
- Factura se crea al confirmar pago.
- Pedido entra a cocina tras pago confirmado.
- No permite editar tras confirmar.
- No permite cancelar en EN_PREPARACION.
- Pedido listo no entregado sigue visible.

17.7. Descuentos
- Admin/super admin crean descuentos.
- Cajero aplica solo descuentos existentes.
- No permite global + linea en la misma factura.
- No permite mas de un descuento por producto.
- Valida sucursal y vigencia.
- Guarda motivo.
- Guarda aplicador/autorizador.
- Se refleja en ticket.

17.8. Seguridad
- No hay SQL concatenado con input del usuario.
- No hay dangerouslySetInnerHTML con datos no sanitizados.
- No hay errores internos expuestos al cliente.
- No se confia en totales del frontend.
- CSRF activo en mutaciones.
- Permisos validados en backend.
- Auditoria registrada en acciones criticas.
- Rate limit en acciones sensibles.


============================================================
18. INSTRUCCIONES PARA CODEX ANTES DE CADA ITERACION
============================================================

Antes de tocar codigo, Codex debe:

1. Leer este documento completo.
2. Revisar el estado actual del repositorio.
3. Ejecutar git status.
4. Identificar archivos exactos a modificar.
5. Verificar estructura real de base de datos mediante MCP Supabase si esta disponible.
6. No asumir nombres de roles, permisos, columnas o tablas.
7. Explicar primero que encontro.
8. Proponer cambios por fase.
9. No modificar todo de una vez si el alcance es grande.
10. Implementar cambios pequenos, verificables y reversibles.
11. Mantener compatibilidad con el flujo actual.
12. No romper modulos existentes.
13. No eliminar codigo sin justificar.
14. No introducir secretos.
15. No incluir logs ni zips en commits.
16. Al finalizar, listar archivos modificados.
17. Al finalizar, explicar pruebas realizadas.
18. Al finalizar, indicar pendientes reales sin exagerar.

Codex debe trabajar despacio y por fases:
- Fase 0: verificacion.
- Fase 1: cambios minimos.
- Fase 2: pruebas.
- Fase 3: siguiente bloque.

No debe entregar resumenes inflados. Debe decir exactamente que hizo y que no hizo.


============================================================
19. UBICACION RECOMENDADA PARA ESTE DOCUMENTO
============================================================

Se recomienda pegar este contenido en uno o varios lugares:

1. Archivo raiz del repositorio:
   AGENTS.md

   Motivo:
   - Es un buen lugar para instrucciones permanentes a agentes de IA.
   - Codex suele poder leerlo como contexto del proyecto.
   - Debe estar en la raiz del proyecto backend y/o frontend si se trabajan separados.

2. Archivo adicional de documentacion:
   docs/reglas_negocio_ventas.md

   Motivo:
   - Sirve para el equipo humano.
   - Puede versionarse.
   - Puede revisarse en pull requests.

3. Prompt inicial de cada chat con Codex:
   Pegar una version resumida o decir:
   "Lee AGENTS.md y docs/reglas_negocio_ventas.md antes de modificar codigo."

4. Si backend y frontend estan en carpetas separadas:
   - jonnys/AGENTS.md
   - jonnys-smartorder/AGENTS.md
   - docs/reglas_negocio_ventas.md

Recomendacion practica:
- Colocar la version completa en docs/reglas_negocio_ventas.md.
- Colocar una version ejecutiva en AGENTS.md que obligue a Codex a leer el documento completo.


============================================================
20. INSTRUCCION EJECUTIVA CORTA PARA AGENTS.md
============================================================

Pegar esto al inicio de AGENTS.md:

"Antes de modificar codigo, lee docs/reglas_negocio_ventas.md. Todas las reglas de ventas, inventario, cocina, pedidos, reversiones, descuentos, caja, ticket termico, seguridad, auditoria y eficiencia son obligatorias. No asumas nombres de tablas, columnas, roles ni permisos: verifica en codigo y base de datos. No expongas errores internos al cliente. No uses SQL concatenado con input del usuario. No implementes cambios grandes sin dividirlos por fases verificables. Toda operacion critica debe validarse en backend, ser transaccional, auditable e idempotente."


============================================================
FIN DEL DOCUMENTO
============================================================