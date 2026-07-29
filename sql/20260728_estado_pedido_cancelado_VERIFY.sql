-- Verificacion exclusivamente de lectura (ningun DDL/DML). Segura de
-- ejecutar en cualquier entorno, antes y despues de aplicar el SAFE.

-- 1) Fila(s) que hoy resuelven a CANCELADO por descripcion normalizada,
-- igual que ESTADO_PEDIDO_CODES.CANCELADO en routers/ventas/constants.js.
-- Se espera exactamente 1 fila despues de aplicar el SAFE (0 antes).
SELECT
  id_estado_pedido,
  descripcion,
  UPPER(TRIM(descripcion)) AS descripcion_normalizada
FROM public.estados_pedido
WHERE UPPER(TRIM(descripcion)) IN ('CANCELADO', 'CANCELADA', 'ANULADO', 'ANULADA')
ORDER BY id_estado_pedido;

-- 2) Catalogo completo de estados_pedido, para inspeccion manual de que no
-- se haya duplicado ni alterado ningun otro estado (PENDIENTE, EN_COCINA,
-- EN_PREPARACION, LISTO_PARA_ENTREGA, COMPLETADO, NO_ENTREGADO, etc.).
SELECT id_estado_pedido, descripcion
FROM public.estados_pedido
ORDER BY id_estado_pedido;

-- 3) Cuantos pedidos referencian ya el nuevo estado (se espera 0
-- inmediatamente despues de aplicar el SAFE, porque nada en Fase 1 escribe
-- en pedidos.id_estado_pedido).
SELECT COUNT(*) AS pedidos_en_cancelado
FROM public.pedidos p
INNER JOIN public.estados_pedido ep ON ep.id_estado_pedido = p.id_estado_pedido
WHERE UPPER(TRIM(ep.descripcion)) IN ('CANCELADO', 'CANCELADA', 'ANULADO', 'ANULADA');

-- 4) Evidencia de regresion cero: ningun otro estado fue tocado (comparar
-- manualmente el conteo antes/despues de SAFE; debe ser igual + 1).
SELECT COUNT(*) AS total_estados_pedido FROM public.estados_pedido;
