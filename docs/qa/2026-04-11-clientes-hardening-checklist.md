# QA Checklist - Clientes (2026-04-11)

## Precondiciones
- Migracion aplicada: `docs/sql/2026-04-11-clientes-multisucursal-empresa-cliente.sql`.
- Backend reiniciado.
- Login renovado para obtener JWT con `id_empresa`.

## Casos funcionales criticos
1. Sucursal A seleccionada:
- `GET /clientes?id_sucursal=<A>` solo devuelve clientes vinculados a A.

2. Sucursal B seleccionada:
- `GET /clientes?id_sucursal=<B>` no muestra clientes exclusivos de A.

3. Cliente empresa visible:
- Crear cliente empresa.
- Verificar que `origen_cliente=empresa` e `id_empresa_cliente` no nulo.

4. Dedupe DNI/RTN:
- Crear cliente con persona/empresa ya existente.
- Esperado: `vinculado=true`, mismo `id_cliente`, sin duplicado.

5. Vinculo por sucursal:
- Repetir alta del mismo cliente en otra sucursal.
- Esperado: nuevo registro en `clientes_sucursales`, no nuevo `id_cliente`.

## Seguridad
1. SQLi en query:
- `GET /clientes?nombre=' OR 1=1 --`
- Esperado: respuesta controlada (400/200 segun validacion), sin SQL interno en `message`.

2. SQLi en params:
- `PUT /clientes/1 OR 1=1`
- Esperado: 400 (`id` invalido), sin stack SQL.

3. SQLi en body:
- `POST /clientes` con `id_persona: "1;DROP TABLE clientes;--"`
- Esperado: 400 validacion.

4. Tenant:
- Usuario no superadmin no puede leer/editar cliente de otro tenant (403).

## Errores historicos
1. Error de esquema cache:
- Simular cambio de esquema y consultar `/clientes`.
- Esperado: reintento automatico y no bloqueo persistente por cache.

