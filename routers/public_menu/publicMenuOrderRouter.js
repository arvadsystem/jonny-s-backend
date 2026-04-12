import express from 'express';
import { createPublicOrderController } from './publicMenuController.js';
import { requireAuthenticatedPublicCustomer } from './publicMenuAuthMiddleware.js';
import {
  publicMenuOrderCreateCustomerLimiter,
  publicMenuOrderCreateIpLimiter
} from './publicMenuRateLimiters.js';
import { validateCreateOrderBody } from './publicMenuValidators.js';

// Router de escritura del menu publico (acciones de pedido).
// Importante:
// - Esta superficie representa la frontera protegida de negocio.
// - Aqui SI exigimos sesion de cliente autenticado + CSRF.
const publicMenuOrderRouter = express.Router();

// Crear pedido desde menu publico.
publicMenuOrderRouter.post(
  '/pedidos',
  // Capa 1: freno por IP para abuso general.
  publicMenuOrderCreateIpLimiter,
  // Capa 2: autentica cliente y prepara contexto de cuenta.
  requireAuthenticatedPublicCustomer,
  // Capa 3: freno por cuenta para doble envio/reintentos agresivos.
  publicMenuOrderCreateCustomerLimiter,
  validateCreateOrderBody,
  createPublicOrderController
);

export default publicMenuOrderRouter;
