export const createApiClient = ({ config, fetchImpl = fetch }) => {
  const request = async (path, { method = 'GET', body } = {}) => {
    const response = await fetchImpl(`${config.apiBaseUrl}/api/print-agent${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        'X-Print-Agent-Id': config.agentId,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.message || `HTTP_${response.status}`), { status: response.status, code: payload.code });
    return payload;
  };
  return {
    heartbeat: (version) => request('/heartbeat', { method: 'POST', body: { version } }),
    claim: () => request('/jobs/claim', { method: 'POST', body: { limit: 1, lease_seconds: config.leaseSeconds } }),
    printing: (id) => request(`/jobs/${id}/printing`, { method: 'POST', body: { lease_seconds: config.leaseSeconds } }),
    confirmationPending: (id) => request(`/jobs/${id}/confirmation-pending`, { method: 'POST', body: {} }),
    complete: (id) => request(`/jobs/${id}/complete`, { method: 'POST', body: {} }),
    fail: (id, error) => request(`/jobs/${id}/fail`, { method: 'POST', body: { error: String(error || '').slice(0, 1000) } }),
    renew: (id) => request(`/jobs/${id}/lease`, { method: 'POST', body: { lease_seconds: config.leaseSeconds } }),
    certificate: async () => (await request('/qz/certificate')).certificate,
    sign: async (jobId, qzRequest, digest) => request('/qz/sign', {
      method: 'POST',
      body: { job_id: jobId, request: qzRequest, digest }
    })
  };
};
