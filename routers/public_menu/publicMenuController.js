import {
  createPublicOrderService,
  getMenuVigenteByBranchService,
  getPublicBranchesService,
  getPublicCatalogItemDetailService,
  getPublicCatalogService
} from './publicMenuService.js';
import { sendPublicMenuClientError, sendPublicMenuError } from './publicMenuResponse.js';

// Respuesta de error uniforme y saneada para controladores del modulo.
const handleControllerError = (req, res, error, fallbackMessage) =>
  sendPublicMenuError(req, res, {
    error,
    fallbackMessage
  });

// GET /public-menu/sucursales
export const getPublicBranchesController = async (req, res) => {
  try {
    const data = await getPublicBranchesService();
    return res.status(200).json({ ok: true, data });
  } catch (error) {
    return handleControllerError(req, res, error, 'No se pudieron listar sucursales publicas.');
  }
};

// GET /public-menu/sucursales/:id_sucursal/menu-vigente
export const getActiveMenuByBranchController = async (req, res) => {
  try {
    const { idSucursal } = req.publicMenu;
    const data = await getMenuVigenteByBranchService(idSucursal);

    if (!data) {
      return sendPublicMenuClientError(req, res, {
        status: 404,
        message: 'La sucursal no tiene menu vigente activo.'
      });
    }

    return res.status(200).json({ ok: true, data });
  } catch (error) {
    return handleControllerError(req, res, error, 'No se pudo resolver el menu vigente de la sucursal.');
  }
};

// GET /public-menu/catalogo?id_sucursal=...&tipo_pedido=...
export const getPublicCatalogController = async (req, res) => {
  try {
    const { idSucursal, tipoPedido } = req.publicMenu;
    const data = await getPublicCatalogService({
      idSucursal,
      tipoPedido
    });

    return res.status(200).json({ ok: true, data });
  } catch (error) {
    return handleControllerError(req, res, error, 'No se pudo construir el catalogo publico.');
  }
};

// GET /public-menu/items/:id_detalle_menu?id_sucursal=...
export const getPublicCatalogItemDetailController = async (req, res) => {
  try {
    const { idSucursal, idDetalleMenu } = req.publicMenu;
    const data = await getPublicCatalogItemDetailService({
      idSucursal,
      idDetalleMenu
    });

    return res.status(200).json({ ok: true, data });
  } catch (error) {
    return handleControllerError(req, res, error, 'No se pudo obtener el detalle del item publico.');
  }
};

// POST /public-menu/pedidos
export const createPublicOrderController = async (req, res) => {
  try {
    const {
      idSucursal,
      tipoPedido,
      origen,
      idempotencyKey,
      business,
      items,
      auth
    } = req.publicMenu;
    const data = await createPublicOrderService({
      idSucursal,
      tipoPedido,
      origen,
      idempotencyKey,
      business,
      items,
      auth
    });

    const replayed = Boolean(data?.idempotency?.replayed);
    return res.status(replayed ? 200 : 201).json({
      ok: true,
      message: replayed
        ? 'Pedido ya registrado previamente; se devuelve el resultado original.'
        : 'Pedido registrado correctamente.',
      data
    });
  } catch (error) {
    return handleControllerError(req, res, error, 'No se pudo registrar el pedido desde menu publico.');
  }
};
