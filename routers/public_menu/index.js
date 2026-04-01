import express from 'express';
import {
  createPublicOrderController,
  getActiveMenuByBranchController,
  getPublicBranchesController,
  getPublicCatalogController,
  getPublicCatalogItemDetailController
} from './publicMenuController.js';
import {
  validateBranchParam,
  validateCatalogQuery,
  validateCreateOrderBody,
  validateItemDetailRequest
} from './publicMenuValidators.js';

// Router publico aislado para menu de clientes.
const router = express.Router();

// Lista inicial de sucursales visibles para cliente final.
router.get('/sucursales', getPublicBranchesController);

// Menu vigente activo por sucursal.
router.get('/sucursales/:id_sucursal/menu-vigente', validateBranchParam, getActiveMenuByBranchController);

// Catalogo publicado usando menu_vigente + detalle_menu.
router.get('/catalogo', validateCatalogQuery, getPublicCatalogController);

// Detalle individual para HU-133.
router.get('/items/:id_detalle_menu', validateItemDetailRequest, getPublicCatalogItemDetailController);

// Crear pedido desde menu publico (sin login de dashboard).
router.post('/pedidos', validateCreateOrderBody, createPublicOrderController);

export default router;
