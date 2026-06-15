# L6B-APPLY-CODIGO-PUBLICACION-DINAMICA-REGLAS

## Resultado tecnico

- Backend actualizado para leer reglas desde `public.menu_publicacion_reglas`.
- No se modifico frontend.
- No se crearon migraciones SQL.
- No se ejecuto SQL de escritura.

## Archivos modificados

- `routers/admin_menu_publicacion.js`
- `services/menuAutoPublicationService.js`

## Cambios

- Catalogo administrativo y preview usan reglas activas con `incluir_catalogo_admin = true`.
- Productos usan `id_categoria_producto` desde reglas `PRODUCTO`.
- Recetas usan `id_tipo_departamento` desde reglas `RECETA`.
- Combos usan `id_tipo_departamento` desde reglas `COMBO`.
- Autopublicacion usa reglas activas con `autopublicar = true`.
- La creacion de filas en `detalle_menu` usa `visible_default` desde la regla.
- Si no existe regla activa/autopublicable, la autopublicacion retorna `0`.

## Validaciones esperadas

- `node --check routers/admin_menu_publicacion.js`
- `node --check services/menuAutoPublicationService.js`
- `git diff --check`
