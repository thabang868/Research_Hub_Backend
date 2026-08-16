const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const supabase = require('../config/supabase');

const PAYSTACK = { secretKey: process.env.PAYSTACK_SECRET_KEY || '', apiUrl: 'https://api.paystack.co' };
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
const PLANS = {
  free_trial: { name: 'Free Trial', price: 0, duration_hours: 24, devices: 1 },
  daily: { name: 'Daily Plan', price: 10, duration_hours: 24, devices: 2 },
  monthly: { name: 'Monthly Plan', price: 50, duration_days: 30, devices: 2 },
  unlimited: { name: 'Unlimited Plan', price: 300, duration_days: null, devices: 2 },
};

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  next();
}

function paystackHeaders() {
  return { Authorization: `Bearer ${PAYSTACK.secretKey}`, 'Content-Type': 'application/json' };
}

function checkoutClientUrl(req) {
  const origin = req.get('origin');
  // Vite may select 5173, 5174, etc. in development. Returning to the
  // initiating local origin prevents Paystack from redirecting to a stale port.
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return CLIENT_URL.replace(/\/$/, '');
}
async function paystackRequest(path, options = {}) {
  const response = await fetch(`${PAYSTACK.apiUrl}${path}`, {
    ...options,
    headers: { ...paystackHeaders(), ...(options.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status === false) {
    const error = new Error(payload.message || 'Paystack request failed');
    error.status = response.status;
    throw error;
  }
  return payload.data;
}

router.get('/plans', (_req, res) => res.json({ plans: PLANS }));
router.get('/subscription', requireAuth, async (req, res) => {
  try { res.json({ subscription: await getActiveSubscription(req.user.id) }); }
  catch (err) { console.error('Get subscription error:', err.message); res.status(500).json({ error: 'Failed to fetch subscription' }); }
});

router.post('/paystack/initialize', requireAuth, async (req, res) => {
  let pendingId = null;
  try {
    const { plan } = req.body;
    if (!plan || !PLANS[plan] || plan === 'free_trial') return res.status(400).json({ error: 'Invalid paid plan' });
    if (!/^sk_(test|live)_/.test(PAYSTACK.secretKey)) return res.status(503).json({ error: 'Paystack is not configured' });

    const { data: pending, error } = await supabase.from('subscriptions').insert({
      // `cancelled` is an inert placeholder supported by the original schema.
      // It grants no access and is activated only after Paystack verification.
      user_id: req.user.id, plan, status: 'cancelled', started_at: new Date().toISOString(),
      expires_at: null,
    }).select().single();
    if (error || !pending) throw new Error('Failed to create pending subscription');
    pendingId = pending.id;
    const reference = pending.id;

    const amount = Math.round(PLANS[plan].price * 100);
    const clientUrl = checkoutClientUrl(req);
    const checkout = await paystackRequest('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email: req.user.email, amount, currency: 'ZAR', reference,
        callback_url: `${clientUrl}/pricing`,
        metadata: {
          subscriptionId: pending.id, userId: req.user.id, plan, expectedAmount: amount,
          cancel_action: `${clientUrl}/pricing?payment=cancelled`,
        },
      }),
    });
    res.json({ redirectUrl: checkout.authorization_url, reference: checkout.reference });
  } catch (err) {
    if (pendingId) await supabase.from('subscriptions').delete().eq('id', pendingId);
    console.error('Paystack initialize error:', err.message);
    res.status(err.status === 401 ? 502 : 500).json({ error: 'Failed to initialize Paystack payment' });
  }
});

router.get('/paystack/verify/:reference', requireAuth, async (req, res) => {
  try {
    const transaction = await paystackRequest(`/transaction/verify/${encodeURIComponent(req.params.reference)}`);
    res.json({ subscription: await verifyAndActivate(transaction, req.user.id) });
  } catch (err) {
    console.error('Paystack verify error:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Payment verification failed' });
  }
});

router.post('/paystack/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const expected = crypto.createHmac('sha512', PAYSTACK.secretKey).update(raw).digest('hex');
    const received = String(req.headers['x-paystack-signature'] || '');
    if (!received || received.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
      return res.status(401).send('Invalid signature');
    }
    const event = JSON.parse(raw.toString('utf8'));
    if (event.event === 'charge.success') await verifyAndActivate(event.data);
    res.sendStatus(200);
  } catch (err) { console.error('Paystack webhook error:', err.message); res.sendStatus(400); }
});

async function verifyAndActivate(transaction, authenticatedUserId = null) {
  if (transaction.status !== 'success') throw new Error('Payment has not completed');
  const { data: pending } = await supabase.from('subscriptions').select('*')
    .eq('id', transaction.reference).eq('status', 'cancelled').single();
  if (!pending) {
    const { data: existing } = await supabase.from('subscriptions').select('*')
      .eq('id', transaction.reference).eq('status', 'active').single();
    if (existing && (!authenticatedUserId || existing.user_id === authenticatedUserId)) return existing;
    throw new Error('Pending subscription not found');
  }
  const metadata = transaction.metadata || {};
  if (authenticatedUserId && pending.user_id !== authenticatedUserId) throw new Error('Payment does not belong to this user');
  if (metadata.userId && metadata.userId !== pending.user_id) throw new Error('Payment ownership mismatch');
  if (metadata.plan && metadata.plan !== pending.plan) throw new Error('Payment plan mismatch');
  const expectedAmount = Math.round(PLANS[pending.plan].price * 100);
  if (Number(transaction.amount) !== expectedAmount || transaction.currency !== 'ZAR') throw new Error('Payment amount or currency mismatch');

  const now = new Date();
  let expiresAt = null;
  if (PLANS[pending.plan].duration_hours) expiresAt = new Date(now.getTime() + PLANS[pending.plan].duration_hours * 3600000).toISOString();
  else if (PLANS[pending.plan].duration_days) expiresAt = new Date(now.getTime() + PLANS[pending.plan].duration_days * 86400000).toISOString();
  await supabase.from('subscriptions').update({ status: 'expired', updated_at: now.toISOString() })
    .eq('user_id', pending.user_id).eq('status', 'active');
  const { data: active, error } = await supabase.from('subscriptions').update({
    status: 'active', started_at: now.toISOString(), expires_at: expiresAt, updated_at: now.toISOString(),
  }).eq('id', pending.id).select().single();
  if (error || !active) throw new Error('Failed to activate subscription');
  return active;
}

router.post('/cancel', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('subscriptions').update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('user_id', req.user.id).eq('status', 'active');
    if (error) throw error;
    res.json({ message: 'Subscription cancelled' });
  } catch { res.status(500).json({ error: 'Failed to cancel subscription' }); }
});

async function getActiveSubscription(userId) {
  const { data } = await supabase.from('subscriptions').select('*').eq('user_id', userId).eq('status', 'active').single();
  if (!data) return null;
  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    await supabase.from('subscriptions').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', data.id);
    return null;
  }
  return data;
}

router.getActiveSubscription = getActiveSubscription;
router.createFreeTrial = async function (userId) {
  await supabase.from('subscriptions').insert({
    user_id: userId, plan: 'free_trial', status: 'active', started_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });
};

module.exports = router;
