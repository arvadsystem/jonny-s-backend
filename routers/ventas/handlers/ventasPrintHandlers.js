import pool from '../../../config/db-connection.js';
import {
  ImpresorasConfigSucursalService,
  obtenerConfiguracionImpresorasRuntime,
  registrarDeteccionImpresorasPorCaja
} from '../../../services/impresorasConfigSucursalService.js';
import { buildVentaDetailPayload } from './ventasReadHandlers.js';
import {
  normalizePrintEventPayload,
  registerVentaPrintEvent
} from '../services/ventasPrintAuditService.js';
import {
  getQzSigningConfiguration,
  getQzPublicErrorMessage,
  isQzSucursalContextRequired,
  isQzConfigurationError,
  signQzMessageWithContext
} from '../services/qzTraySigningService.js';
import { parsePositiveInt } from '../utils/parseUtils.js';
import { resolveRequestUserSucursalScope } from '../../../utils/sucursalScope.js';
import {
  buildPedidoKitchenPrintPayload,
  toKitchenComplementos,
  toKitchenExtras
} from '../services/pedidoKitchenPrintPayloadService.js';

const sendVentasInternalError = (
  res,
  message = 'No se pudo procesar la solicitud de impresion.'
) => res.status(500).json({ error: true, message });

const DETECTION_ORIGIN_MAX_LENGTH = 60;

const normalizeRoleSet = (roles = []) =>
  new Set(
    (Array.isArray(roles) ? roles : [])
      .map((role) => String(role || '').trim().replace(/[\s-]+/g, '_').toUpperCase())
      .filter(Boolean)
  );

const normalizeDetectionOrigin = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return 'MANUAL';
  return normalized.slice(0, DETECTION_ORIGIN_MAX_LENGTH);
};

const normalizeDetectedPrintersPayload = (value) => {
  if (!Array.isArray(value)) {
    return { ok: false, message: 'impresoras_detectadas debe ser un arreglo.' };
  }

  const unique = new Map();
  for (const rawItem of value) {
    const normalized = String(rawItem || '').trim();
    if (!normalized) continue;
    if (normalized.length > 160) {
      return { ok: false, message: 'El nombre de una impresora detectada excede 160 caracteres.' };
    }
    const token = normalized.toLowerCase();
    if (!unique.has(token)) unique.set(token, normalized);
  }

  return { ok: true, value: [...unique.values()] };
};

const validateDeviceDetectionSessionScope = async ({
  client,
  req,
  idSucursal,
  idCaja,
  idSesionCaja
}) => {
  const scope = await resolveRequestUserSucursalScope(req, client);
  const roleSet = normalizeRoleSet(req.user?.roles);
  const isSuperAdmin = Boolean(scope.isSuperAdmin || roleSet.has('SUPER_ADMIN'));
  const actorUserId = Number(req.user?.id_usuario || 0) || null;

  if (!actorUserId) {
    throw new ImpresorasConfigSucursalService.ServiceError('Sesion invalida.', 401);
  }

  if (!isSuperAdmin && !scope.allowedSucursalIds.includes(idSucursal)) {
    throw new ImpresorasConfigSucursalService.ServiceError(
      'No tienes permiso para operar esta sucursal.',
      403
    );
  }

  const sessionResult = await client.query(
    `
      SELECT
        cs.id_sesion_caja,
        cs.id_caja,
        cs.id_sucursal,
        cs.id_usuario_responsable,
        cs.fecha_cierre,
        c.estado AS caja_activa,
        UPPER(TRIM(st.codigo)) AS estado_codigo,
        EXISTS (
          SELECT 1
          FROM public.cajas_sesiones_participantes csp
          WHERE csp.id_sesion_caja = cs.id_sesion_caja
            AND csp.id_usuario = $4
            AND COALESCE(csp.activo, true) = true
        ) AS actor_participa
      FROM public.cajas_sesiones cs
      INNER JOIN public.cajas c
        ON c.id_caja = cs.id_caja
      INNER JOIN public.cat_cajas_sesiones_estados st
        ON st.id_estado_sesion_caja = cs.id_estado_sesion_caja
      WHERE cs.id_sesion_caja = $1
        AND cs.id_caja = $2
        AND cs.id_sucursal = $3
      LIMIT 1
    `,
    [idSesionCaja, idCaja, idSucursal, actorUserId]
  );

  if (sessionResult.rowCount === 0) {
    throw new ImpresorasConfigSucursalService.ServiceError(
      'La sesion de caja no coincide con la caja y sucursal enviadas.',
      409
    );
  }

  const session = sessionResult.rows[0];
  const isOpen = session.estado_codigo === 'ABIERTA' && !session.fecha_cierre;
  if (!isOpen) {
    throw new ImpresorasConfigSucursalService.ServiceError(
      'La sesion de caja no esta abierta.',
      409
    );
  }
  if (session.caja_activa === false) {
    throw new ImpresorasConfigSucursalService.ServiceError(
      'La caja indicada no esta activa.',
      409
    );
  }

  const actorCanOperate = isSuperAdmin
    || Number(session.id_usuario_responsable || 0) === actorUserId
    || Boolean(session.actor_participa);
  if (!actorCanOperate) {
    throw new ImpresorasConfigSucursalService.ServiceError(
      'No participas en la sesion de caja indicada.',
      403
    );
  }

  return {
    actorUserId,
    isSuperAdmin
  };
};

export const buildVentaKitchenPrintPayload = (venta = {}, printerConfig = null) => {
  const cocinaConfig = (Array.isArray(printerConfig?.impresoras) ? printerConfig.impresoras : [])
    .find((item) => String(item?.tipo_impresora || '').trim().toUpperCase() === 'COCINA');

  const items = (Array.isArray(venta?.items) ? venta.items : []).map((item, index) => {
    const isStandaloneExtra = Boolean(
      item?.es_linea_extra_independiente || item?.origen_snapshot?.es_linea_extra_independiente
    );

    return {
      linea: index + 1,
      id_detalle: Number(item?.id_detalle || 0) || null,
      tipo_item: String(item?.tipo_item || 'ITEM').trim().toUpperCase(),
      cantidad: Number(item?.cantidad ?? 0) || 0,
      nombre_item: String(item?.nombre_item || item?.nombre_producto || 'Item de cocina').trim(),
      observacion: String(item?.observacion || '').trim() || null,
      es_linea_extra_independiente: isStandaloneExtra,
      extras: isStandaloneExtra ? [] : toKitchenExtras(item?.extras),
      complementos: toKitchenComplementos(item)
    };
  });

  const totalProductos = items.reduce((sum, item) => sum + Math.max(0, Number(item.cantidad || 0)), 0);

  return {
    id_factura: Number(venta?.id_factura || 0) || null,
    id_pedido: Number(venta?.id_pedido || 0) || null,
    numero_venta: venta?.numero_venta || venta?.codigo_venta || null,
    numero_pedido: venta?.numero_venta || venta?.codigo_venta || null,
    fecha_hora_pedido: venta?.fecha_hora_pedido || venta?.fecha_hora_facturacion || null,
    fecha_hora_facturacion: venta?.fecha_hora_facturacion || venta?.fecha_hora_pedido || null,
    id_sucursal: Number(venta?.id_sucursal || 0) || null,
    nombre_sucursal: venta?.nombre_sucursal || null,
    id_usuario: Number(venta?.id_usuario || 0) || null,
    nombre_usuario: venta?.nombre_usuario || null,
    id_caja: Number(venta?.id_caja || 0) || null,
    nombre_caja: venta?.nombre_caja || venta?.codigo_caja || null,
    cliente_nombre: venta?.contacto?.nombre_contacto || venta?.cliente_nombre || null,
    modalidad: venta?.contexto?.modalidad || venta?.modalidad || null,
    canal: venta?.contexto?.canal || null,
    contacto: venta?.contacto || null,
    delivery: venta?.delivery || null,
    total_productos: totalProductos,
    items,
    print_config: {
      printMode: cocinaConfig?.modo_impresion || 'BROWSER',
      printerType: 'COCINA',
      logicalPrinterName: 'COCINA',
      systemPrinterName: cocinaConfig?.nombre_impresora_sistema || null,
      width_mm: Number(cocinaConfig?.ancho_mm) === 58 ? 58 : 80,
      id_impresora: Number(cocinaConfig?.id_impresora || 0) || null,
      ip_impresora: cocinaConfig?.ip_impresora || null,
      puerto_impresora: Number(cocinaConfig?.puerto_impresora || 0) || 9100
    }
  };
};

export const getVentasPrinterConfigHandler = async (req, res) => {
  try {
    const idSucursal = parsePositiveInt(req.query?.id_sucursal);
    const idCaja = parsePositiveInt(req.query?.id_caja);
    if (!idSucursal) {
      return res.status(400).json({ error: true, message: 'id_sucursal es obligatorio.' });
    }

    const data = await obtenerConfiguracionImpresorasRuntime({
      idSucursal,
      idCaja
    });

    return res.status(200).json(data);
  } catch (error) {
    console.error('Error al obtener configuracion runtime de impresoras:', error);
    return sendVentasInternalError(res, 'No se pudo obtener la configuracion de impresion.');
  }
};

export const createVentasPrinterDeviceDetectionHandler = async (req, res) => {
  const client = await pool.connect();
  try {
    const idSucursal = parsePositiveInt(req.body?.id_sucursal);
    const idCaja = parsePositiveInt(req.body?.id_caja);
    const idSesionCaja = parsePositiveInt(req.body?.id_sesion_caja);
    const normalizedPrinters = normalizeDetectedPrintersPayload(req.body?.impresoras_detectadas);

    if (!idSucursal || !idCaja || !idSesionCaja) {
      return res.status(400).json({
        error: true,
        message: 'id_sucursal, id_caja e id_sesion_caja son obligatorios.'
      });
    }
    if (!normalizedPrinters.ok) {
      return res.status(400).json({ error: true, message: normalizedPrinters.message });
    }

    await validateDeviceDetectionSessionScope({
      client,
      req,
      idSucursal,
      idCaja,
      idSesionCaja
    });

    const result = await registrarDeteccionImpresorasPorCaja({
      idSucursal,
      idCaja,
      impresorasDetectadas: normalizedPrinters.value,
      db: client
    });

    const statusCode = result.status === 'NO_DETECTADO' ? 200 : 200;
    return res.status(statusCode).json({
      ok: true,
      status: result.status,
      origen: normalizeDetectionOrigin(req.body?.origen),
      id_sucursal: idSucursal,
      id_caja: idCaja,
      id_sesion_caja: idSesionCaja,
      impresoras_detectadas: result.detected_printers,
      summary: result.summary,
      assignments: result.assignments,
      runtime: result.runtime
    });
  } catch (error) {
    if (error instanceof ImpresorasConfigSucursalService.ServiceError) {
      return res.status(error.status || 500).json({
        error: true,
        message: error.message,
        details: error.details || null
      });
    }
    console.error('Error al registrar deteccion operativa de impresoras:', error);
    return sendVentasInternalError(res, 'No se pudo validar la deteccion de impresoras.');
  } finally {
    client.release();
  }
};

const validateQzSucursalAccess = async (req, idSucursal) => {
  const sucursalResult = await pool.query(
    `
      SELECT 1
      FROM public.sucursales
      WHERE id_sucursal = $1
      LIMIT 1
    `,
    [idSucursal]
  );
  if (sucursalResult.rowCount === 0) {
    return {
      status: 404,
      body: {
        error: true,
        code: 'QZ_SUCURSAL_NOT_FOUND',
        message: 'La sucursal solicitada no existe.'
      }
    };
  }

  const scope = await resolveRequestUserSucursalScope(req, pool);
  const allowedSucursalIds = Array.isArray(scope.allowedSucursalIds)
    ? scope.allowedSucursalIds.map(Number)
    : [];

  if (!scope.isSuperAdmin && !allowedSucursalIds.includes(idSucursal)) {
    return {
      status: 403,
      body: {
        error: true,
        code: 'QZ_SUCURSAL_FORBIDDEN',
        message: 'No tienes permiso para operar esta sucursal.'
      }
    };
  }

  return null;
};

const hasQzSucursalInput = (value) => (
  value !== undefined && value !== null && String(value).trim() !== ''
);

const buildQzCredentialLogContext = (idSucursal, credentialSource) => ({
  id_sucursal: idSucursal || null,
  credential_source: credentialSource === 'sucursal' ? 'sucursal' : 'default',
  legacy_client: !idSucursal
});

export const getQzCertificateHandler = async (req, res) => {
  const rawIdSucursal = req.query?.id_sucursal;
  const idSucursal = parsePositiveInt(rawIdSucursal);
  if (hasQzSucursalInput(rawIdSucursal) && !idSucursal) {
    return res.status(400).json({
      error: true,
      code: 'QZ_SUCURSAL_REQUIRED',
      message: 'id_sucursal debe ser un entero mayor a 0.'
    });
  }
  if (!idSucursal && isQzSucursalContextRequired()) {
    return res.status(400).json({
      error: true,
      code: 'QZ_SUCURSAL_REQUIRED',
      message: 'id_sucursal es obligatorio.'
    });
  }

  try {
    if (idSucursal) {
      const accessError = await validateQzSucursalAccess(req, idSucursal);
      if (accessError) return res.status(accessError.status).json(accessError.body);
    }

    const config = await getQzSigningConfiguration({
      idSucursal,
      allowGlobalWithoutSucursal: !idSucursal
    });
    console.info(
      '[ventas.qz.certificate] configuracion resuelta',
      buildQzCredentialLogContext(idSucursal, config.credentialSource)
    );

    return res.status(200).json({
      ok: true,
      configured: true,
      certificate: config.certificateText
    });
  } catch (error) {
    if (isQzConfigurationError(error)) {
      console.warn(
        '[ventas.qz.certificate] configuracion no disponible',
        buildQzCredentialLogContext(idSucursal, error?.credentialSource)
      );
      return res.status(503).json({
        error: true,
        code: error?.code || 'QZ_SIGNING_NOT_CONFIGURED',
        message: getQzPublicErrorMessage()
      });
    }

    console.error('[ventas.qz.certificate] error inesperado');
    return sendVentasInternalError(res, 'No se pudo obtener el certificado de impresion.');
  }
};

export const signQzRequestHandler = async (req, res) => {
  const rawIdSucursal = req.body?.id_sucursal;
  const idSucursal = parsePositiveInt(rawIdSucursal);
  if (hasQzSucursalInput(rawIdSucursal) && !idSucursal) {
    return res.status(400).json({
      error: true,
      code: 'QZ_SUCURSAL_REQUIRED',
      message: 'id_sucursal debe ser un entero mayor a 0.'
    });
  }
  if (!idSucursal && isQzSucursalContextRequired()) {
    return res.status(400).json({
      error: true,
      code: 'QZ_SUCURSAL_REQUIRED',
      message: 'id_sucursal es obligatorio.'
    });
  }

  try {
    const request = typeof req.body?.request === 'string' ? req.body.request : '';
    if (request.length === 0) {
      return res.status(400).json({
        error: true,
        code: 'QZ_SIGN_REQUEST_INVALID',
        message: 'request es obligatorio.'
      });
    }

    if (idSucursal) {
      const accessError = await validateQzSucursalAccess(req, idSucursal);
      if (accessError) return res.status(accessError.status).json(accessError.body);
    }

    const { signature, credentialSource } = await signQzMessageWithContext(request, {
      idSucursal,
      allowGlobalWithoutSucursal: !idSucursal
    });
    console.info(
      '[ventas.qz.sign] solicitud firmada',
      buildQzCredentialLogContext(idSucursal, credentialSource)
    );
    return res.status(200).json({ ok: true, signature });
  } catch (error) {
    if (isQzConfigurationError(error)) {
      console.warn(
        '[ventas.qz.sign] configuracion no disponible',
        buildQzCredentialLogContext(idSucursal, error?.credentialSource)
      );
      return res.status(503).json({
        error: true,
        code: error?.code || 'QZ_SIGNING_NOT_CONFIGURED',
        message: getQzPublicErrorMessage()
      });
    }
    if (error?.code === 'QZ_SIGN_REQUEST_INVALID') {
      return res.status(400).json({
        error: true,
        code: error.code,
        message: 'request es obligatorio.'
      });
    }

    console.error('[ventas.qz.sign] error inesperado');
    return sendVentasInternalError(res, 'No se pudo firmar la solicitud de impresion.');
  }
};

export const getVentaKitchenComandaByIdHandler = async (req, res) => {
  try {
    const idFactura = parsePositiveInt(req.params.id);
    if (!idFactura) {
      return res.status(400).json({ error: true, message: 'ID de venta invalido.' });
    }

    const result = await buildVentaDetailPayload(req, {
      idFactura,
      includePrintAssets: false
    });
    if (result.status !== 200) {
      return res.status(result.status).json(result.body);
    }

    const printerConfig = await obtenerConfiguracionImpresorasRuntime({
      idSucursal: result.body?.id_sucursal,
      idCaja: result.body?.id_caja
    }).catch(() => null);

    return res.status(200).json(buildVentaKitchenPrintPayload(result.body, printerConfig));
  } catch (error) {
    console.error('Error al obtener comanda de cocina:', error);
    return sendVentasInternalError(res, 'No se pudo generar la comanda de cocina.');
  }
};

export const getPedidoKitchenComandaByIdHandler = async (req, res) => {
  const client = await pool.connect();
  try {
    const idPedido = parsePositiveInt(req.params.id);
    if (!idPedido) {
      return res.status(400).json({ error: true, message: 'ID de pedido invalido.' });
    }

    const pedidoComanda = await buildPedidoKitchenPrintPayload(client, idPedido);
    if (!pedidoComanda) {
      return res.status(404).json({ error: true, message: 'Pedido no encontrado.' });
    }

    const printerConfig = await obtenerConfiguracionImpresorasRuntime({
      idSucursal: pedidoComanda.id_sucursal,
      idCaja: pedidoComanda.id_caja
    }).catch(() => null);

    return res.status(200).json(buildVentaKitchenPrintPayload(pedidoComanda, printerConfig));
  } catch (error) {
    console.error('Error al obtener comanda de cocina por pedido:', error);
    return sendVentasInternalError(res, 'No se pudo generar la comanda de cocina del pedido.');
  } finally {
    client.release();
  }
};

export const createVentaPrintEventHandler = async (req, res) => {
  try {
    const idFactura = parsePositiveInt(req.params.id);
    if (!idFactura) {
      return res.status(400).json({ error: true, message: 'ID de venta invalido.' });
    }

    const normalized = normalizePrintEventPayload(req.body);
    if (!normalized.ok) {
      return res.status(400).json({ error: true, message: normalized.message });
    }

    const detailResult = await buildVentaDetailPayload(req, {
      idFactura,
      includePrintAssets: false
    });
    if (detailResult.status !== 200) {
      return res.status(detailResult.status).json(detailResult.body);
    }

    const auditResult = await registerVentaPrintEvent({
      client: pool,
      idFactura,
      idPedido: detailResult.body?.id_pedido || null,
      idUsuario: req.user?.id_usuario || null,
      idSucursal: detailResult.body?.id_sucursal || null,
      payload: normalized.value
    });

    return res.status(200).json({
      ok: true,
      ...auditResult
    });
  } catch (error) {
    console.error('Error al registrar auditoria de impresion:', error);
    return sendVentasInternalError(res, 'No se pudo registrar el evento de impresion.');
  }
};
