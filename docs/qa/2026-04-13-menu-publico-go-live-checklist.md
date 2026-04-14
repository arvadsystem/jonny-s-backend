# QA Menu Publico - Pre Go-Live

Fecha: 2026-04-13

## 1) Ejecucion automatizada (solo modulo Menu)

```bash
npm run qa:menu-publico
```

Casos que ejecuta:

- Lectura publica de sucursales
- Validacion 400 saneada (`PUBLIC_MENU_VALIDATION_ERROR`)
- Lectura de catalogo por sucursal
- Rechazo de pedido sin sesion (`PUBLIC_MENU_UNAUTHORIZED`)
- Detalle de item por `id_detalle_menu`
- Flujo autenticado (si hay credenciales):
  - login cliente
  - rechazo `pickup` sin comprobante
  - rechazo `delivery` sin direccion
  - creacion valida `dine-in`, `pickup`, `delivery`
  - verificacion en BD (`estado_pago`, `tipo_entrega`, `configuracion_menu`)
- Rate limit (opcional) con `MENU_QA_RATE_LIMIT_STRESS=1`

## 2) Variables de entorno para flujo autenticado

Sin estas variables, los casos con login se marcan como `SKIP`.

```bash
MENU_QA_BASE_URL=http://localhost:3001
MENU_QA_IDENTIFIER=correo_o_usuario_cliente
MENU_QA_PASSWORD=clave_cliente
MENU_QA_BRANCH_ID=1
```

Opcional:

```bash
MENU_QA_RATE_LIMIT_STRESS=1
```

## 3) Criterio de salida

- `QA MENU FINAL: PASS` = sin casos fallidos (puede haber `SKIP` por falta de credenciales).
- `QA MENU FINAL: FAIL` = al menos un caso critico fallo y no debe considerarse listo para salida.

