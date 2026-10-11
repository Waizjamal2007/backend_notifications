'use strict';
const {ApiError} = require('./service');
function createHandler(getDependencies, createService) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (origin && allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return res.status(405).json({error: 'Use POST.'}); }
    try {
      if (origin && !allowed.includes(origin)) throw new ApiError(403, 'Origin not allowed.');
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'Use application/json.');
      const header = req.headers.authorization || '';
      if (!header.startsWith('Bearer ')) throw new ApiError(401, 'Sign in first.');
      const deps = getDependencies();
      let decoded;
      try { decoded = await deps.auth.verifyIdToken(header.slice(7), true); }
      catch (_) { throw new ApiError(401, 'Session expired. Sign in again.'); }
      const user = await deps.auth.getUser(decoded.uid);
      const profile = (await deps.db.ref(`users/${user.uid}`).get()).val();
      if (user.disabled || !user.emailVerified || profile?.disabled === true) throw new ApiError(403, 'Verify your email and use an active account.');
      let body;
      try { body = req.body; } catch (_) { throw new ApiError(400, 'Invalid JSON.'); }
      if (typeof body === 'string') { try {body = JSON.parse(body);} catch (_) {throw new ApiError(400, 'Invalid JSON.');} }
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.action !== 'string' ||
          (body.data != null && (typeof body.data !== 'object' || Array.isArray(body.data)))) throw new ApiError(400, 'Send action and data.');
      const result = await createService(deps).execute(body.action, user, body.data || {});
      return res.status(200).json({ok: true, data: result});
    } catch (error) {
      const code = error.status || (error.code === 'auth/user-not-found' ? 404 : 500);
      if (code === 500) console.error('API failure:', error.code || error.name);
      return res.status(code).json({ok: false, error: code === 500 ? 'Server error. Check deployment configuration/logs.' : error.message});
    }
  };
}
module.exports = {createHandler};
