import {
  createPublicOrderService,
  getMenuVigenteByBranchService,
  getPublicBranchesService,
  getPublicCatalogItemDetailService,
  getPublicCatalogService
} from './publicMenuService.js';

// Respuesta de error uniforme para evitar duplicacion en cada controlador.
const handleControllerError = (res, error, fallbackMessage) => {
  const status = Number(error?.status) || 500;
  const message = error?.message || fallbackMessage;

  if (status >= 500) {
    console.error('Public menu error:', message, error?.stack || '');
  }

  return res.status(status).json({
    ok: false,
    message
  });
};

// GET /public-menu/sucursales
export const getPublicBranchesController = async (_req, res) => {
  try {
    const data = await getPublicBranchesService();
    return res.status(200).json({ ok: true, data });
  } catch (error) {
    return handleControllerError(res, error, 'No se pudieron listar sucursales publicas.');
  }
};

// GET /public-menu/sucursales/:id_sucursal/menu-vigente
export const getActiveMenuByBranchController = async (req, res) => {
  try {
    const { idSucursal } = req.publicMenu;
    const data = await getMenuVigenteByBranchService(idSucursal);

    if (!data) {
      return res.status(404).json({
        ok: false,
        message: 'La sucursal no tiene menu vigente activo.'
      });
    }

    return res.status(200).json({ ok: true, data });
  } catch (error) {
    return handleControllerError(res, error, 'No se pudo resolver el menu vigente de la sucursal.');
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
    return handleControllerError(res, error, 'No se pudo construir el catalogo publico.');
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
    return handleControllerError(res, error, 'No se pudo obtener el detalle del item publico.');
  }
};

// POST /public-menu/pedidos
export const createPublicOrderController = async (req, res) => {
  try {
    const { idSucursal, tipoPedido, origen, items } = req.publicMenu;
    const data = await createPublicOrderService({
      idSucursal,
      tipoPedido,
      origen,
      items
    });

    return res.status(201).json({
      ok: true,
      message: 'Pedido registrado correctamente.',
      data
    });
  } catch (error) {
    return handleControllerError(res, error, 'No se pudo registrar el pedido desde menu publico.');
  }
};
