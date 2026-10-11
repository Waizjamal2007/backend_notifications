module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ok: true, service: 'Athenaeum backend',
    configured: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)});
};
