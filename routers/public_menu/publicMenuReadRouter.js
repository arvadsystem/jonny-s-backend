import express from 'express';
import {
  getActiveMenuByBranchController,
  getPublicBranchesController,
  getPublicHeroCarouselConfigController,
  getPublicCatalogController,
  getPublicCatalogItemDetailController
} from './publicMenuController.js';
import {
  validateBranchParam,
  validateCatalogQuery,
  validateItemDetailRequest
} from './publicMenuValidators.js';
import {
  publicMenuBranchMenuReadLimiter,
  publicMenuBranchesReadLimiter,
  publicMenuCatalogReadLimiter,
  publicMenuItemDetailReadLimiter
} from './publicMenuRateLimiters.js';

// Router exclusivo de lectura publica del menu.
// Esta superficie SI debe permanecer accesible sin sesion para permitir
// "ver sucursales y precios" antes de iniciar sesion.
const publicMenuReadRouter = express.Router();

// Lista inicial de sucursales visibles para cliente final.
publicMenuReadRouter.get(
  '/sucursales',
  publicMenuBranchesReadLimiter,
  getPublicBranchesController
);

// AM: configuracion global del carrusel hero administrada por panel backend.
publicMenuReadRouter.get(
  '/carrusel-config',
  publicMenuCatalogReadLimiter,
  getPublicHeroCarouselConfigController
);

// Menu vigente activo por sucursal.
publicMenuReadRouter.get(
  '/sucursales/:id_sucursal/menu-vigente',
  publicMenuBranchMenuReadLimiter,
  validateBranchParam,
  getActiveMenuByBranchController
);

// Catalogo publicado usando menu_vigente + detalle_menu.
publicMenuReadRouter.get(
  '/catalogo',
  publicMenuCatalogReadLimiter,
  validateCatalogQuery,
  getPublicCatalogController
);

// Detalle individual para HU-133.
publicMenuReadRouter.get(
  '/items/:id_detalle_menu',
  publicMenuItemDetailReadLimiter,
  validateItemDetailRequest,
  getPublicCatalogItemDetailController
);

export default publicMenuReadRouter;
