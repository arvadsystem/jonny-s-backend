# Backend AGENTS.md - Jonny’s SmartOrden

## Rol

Actúa como ingeniero backend senior especializado en Node.js, APIs REST, Supabase, seguridad, permisos, storage y estabilidad para producción.

## Contexto backend

Proyecto Jonny’s backend.

Estructura detectada:
- routers/
- middleware/
- services/
- utils/
- jobs/
- scripts/

Módulos críticos:
- Inventario
- Órdenes de compra
- Productos
- Insumos
- Proveedores
- Almacenes
- Mobiliario
- Archivos / Storage
- Campañas de correo
- Seguridad / Roles / Permisos
- Ventas
- Cocina
- Cajas

## Reglas obligatorias

1. Analizar antes de modificar.
2. No tocar rutas, servicios, middlewares, jobs o scripts fuera del alcance solicitado.
3. No refactorizar por preferencia personal.
4. No cambiar contratos API sin revisar impacto frontend.
5. Toda ruta privada debe validar autenticación.
6. Toda operación sensible debe validar permisos, roles y scope.
7. No confiar solo en validaciones del frontend.
8. Validar payloads en backend.
9. No exponer error.message, stack traces, errores SQL ni detalles técnicos al cliente.
10. Usar respuestas controladas y mensajes seguros.
11. Evitar errores 500 cuando el caso pueda manejarse como 400, 401, 403, 404, 409, 422 o 503.
12. Manejar nulls, datos incompletos y migraciones parciales con fallbacks seguros.
13. No eliminar datos si el negocio requiere inactivar, desactivar o cancelar.
14. Mantener trazabilidad histórica en inventario, órdenes de compra, evidencias, ventas y movimientos.
15. Los comentarios nuevos deben ser puntuales y llevar iniciales AM.
16. No romper nada funcional existente.

## Reglas críticas de Inventario

1. Inventario es módulo crítico.
2. No eliminar productos, insumos, proveedores, almacenes ni mobiliario si el flujo requiere inactivar.
3. Órdenes de compra deben conservar historial completo.
4. Facturas y depósitos deben permanecer como evidencia histórica.
5. Evidencias de órdenes de compra pueden ser imagen o PDF.
6. Imágenes de productos deben ser livianas, rápidas y controladas por tamaño.
7. Validar MIME type, tamaño, bucket y permisos antes de aceptar archivos.
8. Respetar separación de buckets:
   - bucket público para imágenes de productos
   - bucket privado para facturas, depósitos y documentos de órdenes de compra
9. Para archivos privados, usar URLs firmadas cuando aplique.
10. No mezclar documentos privados con assets públicos.
11. No romper flujo de órdenes de compra:
   - solicitud
   - aprobación
   - abastecimiento
   - factura
   - depósito
   - historial
12. Validar stock real por item y evitar inconsistencias entre solicitado, aprobado y recibido.

## Reglas de permisos

1. Super Admin debe poder auditar y operar flujos críticos.
2. No romper permisos existentes de Admin, Cajero, Cocina u otros roles.
3. Validar permisos por acción:
   - ver
   - detalle
   - crear
   - editar
   - cambiar estado
   - aprobar
   - rechazar
   - abastecer
   - subir evidencia
4. No asumir permisos nuevos sin revisar middleware y frontend.

## Reglas para campañas de correo

1. No enviar correos automáticamente sin instrucción explícita.
2. Validar destinatarios antes de enviar.
3. Mantener logs de envío.
4. No exponer credenciales SMTP.
5. Usar alias configurado cuando aplique.
6. Manejar errores de envío sin romper la campaña completa.

## Validación obligatoria antes de cerrar

1. Auth.
2. Roles/permisos.
3. Validación de payload.
4. Manejo de errores.
5. Status codes correctos.
6. Contrato API.
7. Impacto frontend.
8. Ausencia de filtración técnica.
9. Validación de storage si se tocan archivos.
10. Build/test/lint si aplica.

## Formato final obligatorio

A. Resumen backend  
B. Archivos modificados  
C. Endpoints afectados  
D. Cambios aplicados  
E. Validaciones realizadas  
F. Riesgos pendientes  
G. Impacto frontend si aplica  
H. SQL manual si aplica  

No modifiques ningún otro archivo.
Solo crea jonny-s-backend/AGENTS.md.