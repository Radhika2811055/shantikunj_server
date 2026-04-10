const express = require('express')
const router = express.Router()
const passport = require('passport')
const { protect } = require('../middleware/authMiddleware')
const {
  register,
  login,
  googleCallback,
  verifyEmail,
  getLanguageMembers,
  getAssignableMembers,
  getMyProfile,
  getSupportedLanguages,
  forgotPassword,
  resetPassword
} = require('../controllers/authController')
const isGoogleOAuthConfigured =
  !!process.env.GOOGLE_CLIENT_ID &&
  !!process.env.GOOGLE_CLIENT_SECRET &&
  !!process.env.GOOGLE_CALLBACK_URL
const FRONTEND_BASE_URL = String(process.env.FRONTEND_URL || 'http://localhost:5173').trim().replace(/\/+$/, '')

// Manual auth
router.post('/register', register)
router.post('/login', login)
router.get('/languages', getSupportedLanguages)
router.get('/me', protect, getMyProfile)
router.get('/language-members', protect, getLanguageMembers)
router.get('/assignable-members', protect, getAssignableMembers)
router.get('/verify-email/:token', verifyEmail)
router.post('/forgot-password', forgotPassword)
router.post('/reset-password/:token', resetPassword)

// Google OAuth
router.get('/google', (req, res, next) => {
  if (!isGoogleOAuthConfigured) {
    return res.status(503).json({ message: 'Google OAuth is not configured on server' })
  }
  return passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next)
})

router.get('/google/callback', (req, res, next) => {
  if (!isGoogleOAuthConfigured) {
    return res.status(503).json({ message: 'Google OAuth is not configured on server' })
  }
  return passport.authenticate('google', {
    failureRedirect: `${FRONTEND_BASE_URL}/login?error=google_failed`
  })(req, res, next)
}, googleCallback)

module.exports = router