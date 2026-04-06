/**
 * emailService.js
 * Servicio centralizado de envío de correos para Jonnys SmartOrder.
 * Usa Nodemailer con las credenciales SMTP configuradas en .env
 */
import nodemailer from 'nodemailer';
import pool from '../config/db-connection.js';

// ── Configuración del transporter ─────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '465', 10),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Verificar conexión al arrancar (opcional, controlado por env)
if (process.env.SMTP_VERIFY_ON_BOOT === 'true') {
  transporter.verify()
    .then(() => console.log('✅ [emailService] Conexión SMTP verificada'))
    .catch((err) => console.error('❌ [emailService] Error verificando SMTP:', err.message));
}

const FROM_DEFAULT = process.env.SMTP_FROM || `Jonnys Smart Order <${process.env.SMTP_USER}>`;

// Mapeo de alias según configuración en .env
const FROM_ALIASES = {
  ACCESO: process.env.SMTP_FROM_ACCESO,
  ADMON: process.env.SMTP_FROM_ADMON,
  GERENCIA: process.env.SMTP_FROM_GERENCIA,
  INVENTARIO: process.env.SMTP_FROM_INVENTARIO,
  NORESPONDER: process.env.SMTP_FROM_NORESPONDER,
  PEDIDOS: process.env.SMTP_FROM_PEDIDOS,
  RRHH: process.env.SMTP_FROM_RRHH,
  SOPORTE: process.env.SMTP_FROM_SOPORTE,
};

/**
 * Obtener la dirección 'From' basada en un alias o el default.
 */
const getFromAddress = (fromKey) => {
  const alias = FROM_ALIASES[String(fromKey).toUpperCase()];
  if (alias) {
    return `Jonnys Smart Order <${alias}>`;
  }
  return FROM_DEFAULT;
};

// ── Templates HTML ────────────────────────────────────────────────

/**
 * Template para verificación de cuenta (registro)
 */
const templateVerificacion = (nombreUsuario, linkVerificacion) => `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0; padding:0; background-color:#0e0704; font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px; margin:40px auto; background:#1a1108; border-radius:16px; border:1px solid rgba(212,165,116,0.2);">
    <tr>
      <td style="padding:40px 36px; text-align:center;">
        <h1 style="color:#d4a574; font-size:26px; margin:0 0 6px;">JONNY'S</h1>
        <p style="color:rgba(255,255,255,0.4); font-size:11px; letter-spacing:3px; margin:0 0 32px;">SMARTORDER</p>
        
        <h2 style="color:#fdfaf5; font-size:20px; font-weight:600; margin:0 0 12px;">¡Bienvenido${nombreUsuario ? ', ' + nombreUsuario : ''}!</h2>
        <p style="color:rgba(255,255,255,0.6); font-size:14px; line-height:1.6; margin:0 0 28px;">
          Gracias por registrarte en Jonny's SmartOrder.<br/>
          Para activar tu cuenta, haz clic en el botón de abajo:
        </p>
        
        <a href="${linkVerificacion}" style="display:inline-block; background:#9B4D1A; color:#fff; text-decoration:none; padding:14px 40px; border-radius:30px; font-size:14px; font-weight:600; letter-spacing:1px;">
          VERIFICAR MI CUENTA
        </a>
        
        <p style="color:rgba(255,255,255,0.3); font-size:12px; margin:28px 0 0; line-height:1.5;">
          Si no creaste esta cuenta, puedes ignorar este correo.<br/>
          Este enlace expira en 24 horas.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 36px; border-top:1px solid rgba(255,255,255,0.06); text-align:center;">
        <p style="color:rgba(255,255,255,0.2); font-size:11px; margin:0;">
          © ${new Date().getFullYear()} Jonny's Restaurant · Honduras
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

/**
 * Template para recuperación de contraseña
 */
const templateRecuperacion = (linkRecuperacion) => `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0; padding:0; background-color:#0e0704; font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px; margin:40px auto; background:#1a1108; border-radius:16px; border:1px solid rgba(212,165,116,0.2);">
    <tr>
      <td style="padding:40px 36px; text-align:center;">
        <h1 style="color:#d4a574; font-size:26px; margin:0 0 6px;">JONNY'S</h1>
        <p style="color:rgba(255,255,255,0.4); font-size:11px; letter-spacing:3px; margin:0 0 32px;">SMARTORDER</p>
        
        <h2 style="color:#fdfaf5; font-size:20px; font-weight:600; margin:0 0 12px;">Recuperar contraseña</h2>
        <p style="color:rgba(255,255,255,0.6); font-size:14px; line-height:1.6; margin:0 0 28px;">
          Recibimos una solicitud para restablecer la contraseña de tu cuenta.<br/>
          Haz clic en el botón de abajo para crear una nueva contraseña:
        </p>
        
        <a href="${linkRecuperacion}" style="display:inline-block; background:#9B4D1A; color:#fff; text-decoration:none; padding:14px 40px; border-radius:30px; font-size:14px; font-weight:600; letter-spacing:1px;">
          RESTABLECER CONTRASEÑA
        </a>
        
        <p style="color:rgba(255,255,255,0.3); font-size:12px; margin:28px 0 0; line-height:1.5;">
          Si no solicitaste este cambio, puedes ignorar este correo.<br/>
          Tu contraseña no cambiará hasta que crees una nueva.<br/>
          Este enlace expira en 1 hora.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 36px; border-top:1px solid rgba(255,255,255,0.06); text-align:center;">
        <p style="color:rgba(255,255,255,0.2); font-size:11px; margin:0;">
          © ${new Date().getFullYear()} Jonny's Restaurant · Honduras
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

// ── Funciones de envío ────────────────────────────────────────────

/**
 * Enviar correo genérico.
 * @param {string} to - Email destino
 * @param {string} subject - Asunto
 * @param {string} html - Cuerpo HTML
 * @param {object} [meta] - Metadata para log ({id_usuario, tipo_correo})
 */
const enviarCorreo = async (to, subject, html, meta = {}) => {
  const { id_usuario = null, tipo_correo = 'general', fromKey = null } = meta;

  // Registrar intento en log
  let logId = null;
  try {
    const logRes = await pool.query(
      `INSERT INTO log_correos_enviados (id_usuario, tipo_correo, email_destino, asunto, estado_envio, intentos)
       VALUES ($1, $2, $3, $4, 'enviando', 1) RETURNING id_log`,
      [id_usuario, tipo_correo, to, subject]
    );
    logId = logRes.rows[0]?.id_log;
  } catch (logErr) {
    console.warn('[emailService] No se pudo registrar log de correo:', logErr.message);
  }

  try {
    const fromAddress = getFromAddress(fromKey);
    const info = await transporter.sendMail({ from: fromAddress, to, subject, html });
    console.log(`📧 [emailService] Correo enviado a ${to} (desde ${fromAddress}) — MessageId: ${info.messageId}`);

    // Actualizar log como exitoso
    if (logId) {
      await pool.query(
        `UPDATE log_correos_enviados SET estado_envio = 'enviado', enviado_en = NOW() WHERE id_log = $1`,
        [logId]
      ).catch(() => {});
    }

    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`❌ [emailService] Error enviando correo a ${to}:`, err.message);

    // Actualizar log como fallido
    if (logId) {
      await pool.query(
        `UPDATE log_correos_enviados SET estado_envio = 'fallido', error_detalle = $1 WHERE id_log = $2`,
        [err.message, logId]
      ).catch(() => {});
    }

    throw err;
  }
};

/**
 * Enviar correo de verificación de cuenta.
 */
const enviarVerificacion = async (to, nombreUsuario, linkVerificacion, id_usuario = null) => {
  const html = templateVerificacion(nombreUsuario, linkVerificacion);
  return enviarCorreo(to, 'Verifica tu cuenta — Jonny\'s SmartOrder', html, {
    id_usuario,
    tipo_correo: 'verificacion',
    fromKey: 'ACCESO'
  });
};

/**
 * Enviar correo de recuperación de contraseña.
 */
const enviarRecuperacion = async (to, linkRecuperacion, id_usuario = null) => {
  const html = templateRecuperacion(linkRecuperacion);
  return enviarCorreo(to, 'Recuperar contraseña — Jonny\'s SmartOrder', html, {
    id_usuario,
    tipo_correo: 'recuperacion',
    fromKey: 'ACCESO'
  });
};

export { enviarCorreo, enviarVerificacion, enviarRecuperacion };
export default { enviarCorreo, enviarVerificacion, enviarRecuperacion };
