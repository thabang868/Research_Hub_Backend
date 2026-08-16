const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const billingRoutes = require('./billing');

// Sign Up
router.post('/signup', async (req, res) => {
  try {
    const { name, surname, email, password } = req.body;

    if (!name || !surname || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Create user via signUp (sends verification email automatically)
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name, surname },
        emailRedirectTo: `${process.env.CLIENT_URL}/signin`,
      },
    });

    if (authError) {
      return res.status(400).json({ error: authError.message });
    }

    // Check if user already exists (Supabase returns a fake user with no identities)
    if (authData.user && authData.user.identities && authData.user.identities.length === 0) {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }

    // Insert profile into profiles table
    if (authData.user) {
      const { error: profileError } = await supabase
        .from('profiles')
        .insert({
          id: authData.user.id,
          name,
          surname,
          email,
        });

      if (profileError) {
        console.error('Profile insert error:', profileError);
      }

      // Create 24-hour free trial subscription
      try {
        await billingRoutes.createFreeTrial(authData.user.id);
      } catch (trialErr) {
        console.error('Free trial creation error:', trialErr);
      }
    }

    res.status(201).json({
      message: 'Account created. Please check your email to verify your account.',
      requiresVerification: true,
      user: {
        id: authData.user?.id,
        email: authData.user?.email,
        name,
        surname,
      },
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Sign In
router.post('/signin', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      if (error.message === 'Email not confirmed') {
        return res.status(401).json({ error: 'Please verify your email before signing in. Check your inbox for the verification link.' });
      }
      return res.status(401).json({ error: error.message });
    }

    // Fetch profile and subscription in parallel
    const [profileResult, subscription] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', data.user.id).single(),
      billingRoutes.getActiveSubscription(data.user.id),
    ]);
    const profile = profileResult.data;

    res.json({
      message: 'Signed in successfully',
      user: {
        id: data.user.id,
        email: data.user.email,
        name: profile?.name,
        surname: profile?.surname,
      },
      subscription,
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      },
    });
  } catch (err) {
    console.error('Signin error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Forgot Password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${process.env.CLIENT_URL}/reset-password`,
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: 'Password reset link sent to your email' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reset Password
router.post('/reset-password', async (req, res) => {
  try {
    const { access_token, new_password } = req.body;

    if (!access_token || !new_password) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }

    const { data: { user }, error: userError } = await supabase.auth.getUser(access_token);

    if (userError) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const { error } = await supabase.auth.admin.updateUserById(user.id, {
      password: new_password,
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user profile
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const [profileResult, subscription] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', user.id).single(),
      billingRoutes.getActiveSubscription(user.id),
    ]);
    const profile = profileResult.data;

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: profile?.name,
        surname: profile?.surname,
      },
      subscription,
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
