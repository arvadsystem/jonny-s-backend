const reportNotificationError = (onError, stage, error) => {
  try {
    onError?.(stage, error);
  } catch {
    // El reporte de un fallo de notificacion nunca debe alterar el flujo principal.
  }
};

export const sendPasswordEmailBestEffort = async ({
  resolveEmail,
  isEmailValid = (value) => Boolean(String(value ?? '').trim()),
  sendEmail,
  onError,
}) => {
  let email = null;

  try {
    email = await resolveEmail();
  } catch (error) {
    reportNotificationError(onError, 'resolve', error);
    return {
      sent: false,
      skipped: false,
      reason: 'EMAIL_RESOLUTION_FAILED',
      to: null,
    };
  }

  if (!isEmailValid(email)) {
    return {
      sent: false,
      skipped: true,
      reason: 'EMAIL_NOT_AVAILABLE',
      to: null,
    };
  }

  try {
    await sendEmail(email);
    return { sent: true, skipped: false, to: email };
  } catch (error) {
    reportNotificationError(onError, 'send', error);
    return {
      sent: false,
      skipped: false,
      reason: 'SMTP_SEND_FAILED',
      to: email,
    };
  }
};

export const runInternalPasswordRecoveryTransaction = async ({
  client,
  updatePassword,
  closeSessions,
  sendNotification,
}) => {
  await client.query('BEGIN');

  try {
    const updated = await updatePassword(client);
    if (!updated) {
      await client.query('ROLLBACK');
      return { completed: false, reason: 'USER_NOT_UPDATED', closedSessions: 0 };
    }

    const closedSessions = Number(await closeSessions(client)) || 0;
    await sendNotification(client);
    await client.query('COMMIT');

    return { completed: true, reason: null, closedSessions };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
};
