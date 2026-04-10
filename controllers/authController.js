const User = require('../models/User')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const sendMail = require('../config/mailer')
const crypto = require('crypto')
const {
  TRANSLATION_LANGUAGES,
  normalizeTranslationLanguage
} = require('../constants/languages')

const DISPOSABLE_DOMAINS = new Set([
  'test.com',
  'example.com',
  'mailinator.com',
  'yopmail.com',
  'guerrillamail.com',
  '10minutemail.com',
  'temp-mail.org',
  'fakeinbox.com'
])

const ASSIGNABLE_MEMBER_ROLES = ['translator', 'checker', 'recorder', 'audio_checker']
const normalizeLanguage = (value) => String(value || '').trim().toLowerCase()
const FRONTEND_BASE_URL = String(process.env.FRONTEND_URL || 'http://localhost:5173').trim().replace(/\/+$/, '')

const createAuthPayload = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  language: user.language
})

const createAuthToken = (user) => jwt.sign(
  { userId: user._id, role: user.role },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
)

// ── REGISTER ──────────────────────────────────────────────
const register = async (req, res) => {
  try {
    const { name, email, password, role, language } = req.body
    const normalizedName = String(name || '').trim()
    const normalizedEmail = String(email || '').trim().toLowerCase()
    const requestedLanguageInput = String(language || '').trim()
    const normalizedLanguage = requestedLanguageInput
      ? normalizeTranslationLanguage(requestedLanguageInput)
      : 'English'
    const emailDomain = normalizedEmail.split('@')[1]

    if (normalizedName.length < 2) {
      return res.status(400).json({ message: 'Please enter a valid name' })
    }

    if (!normalizedEmail || !emailDomain) {
      return res.status(400).json({ message: 'Please enter a valid email address' })
    }

    if (!password || String(password).length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long' })
    }

    if (DISPOSABLE_DOMAINS.has(emailDomain)) {
      return res.status(400).json({
        message: 'Disposable/fake email domains are not allowed. Use your real email.'
      })
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email: normalizedEmail })
    if (existingUser) {
      if (existingUser.authMethod === 'google') {
        return res.status(400).json({
          message: 'This email is already linked with Google. Please use Continue with Google.'
        })
      }
      return res.status(400).json({ message: 'Email already registered' })
    }

    if (role === 'admin' || role === 'pending') {
      return res.status(400).json({ message: 'Invalid role selected during registration' })
    }

    if (!normalizedLanguage) {
      return res.status(400).json({ message: 'Please select a supported language' })
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10)
    // Create new user (pending by default)
    const user = await User.create({
      name: normalizedName,
      email: normalizedEmail,
      password: hashedPassword,
      requestedRole: role || 'translator',
      requestedLanguage: normalizedLanguage,
      emailVerified: true,
      emailVerificationToken: null,
      emailVerificationExpiry: null
    })

    res.status(201).json({
      message: 'Registration successful! Please wait for admin approval.',
      userId: user._id
    })

  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

const getSupportedLanguages = (_req, res) => {
  return res.status(200).json({
    languages: TRANSLATION_LANGUAGES
  })
}

// ── LOGIN ─────────────────────────────────────────────────
const login = async (req, res) => {
  try {
    const { email, password } = req.body
    const normalizedEmail = String(email || '').trim().toLowerCase()
    const rawPassword = String(password || '')

    // Find user
    const user = await User.findOne({ email: normalizedEmail })
    if (!user) {
      return res.status(400).json({ message: 'Invalid email or password' })
    }

    // Check if approved
    if (user.status !== 'approved') {
      return res.status(403).json({ 
        message: 'Your account is pending admin approval. Please wait.' 
      })
    }

    // Google-linked account must use Google OAuth login.
    if (user.authMethod === 'google') {
      return res.status(400).json({
        message: 'This account uses Google login. Please use Continue with Google.'
      })
    }

    // Check password
    let isMatch = await bcrypt.compare(rawPassword, user.password)
    if (!isMatch) {
      const trimmedPassword = rawPassword.trim()
      if (trimmedPassword && trimmedPassword !== rawPassword) {
        isMatch = await bcrypt.compare(trimmedPassword, user.password)
      }
    }

    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid email or password' })
    }

    const token = createAuthToken(user)

    res.status(200).json({
      message: 'Login successful',
      token,
      user: createAuthPayload(user)
    })

  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}


// ── Google OAuth callback ──────────────────────────────────
const googleCallback = async (req, res) => {
  try {
    const user = req.user

    // If user is not approved yet
    if (user.status !== 'approved') {
      return res.redirect(
        `${FRONTEND_BASE_URL}/login?error=pending`
      )
    }

    // Create JWT token
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    )

    // Redirect to frontend with token
    const params = new URLSearchParams({
      token,
      id: String(user._id),
      name: user.name || '',
      email: user.email || '',
      role: user.role || 'pending',
      language: user.language || ''
    })

    res.redirect(`${FRONTEND_BASE_URL}/auth/google/success?${params.toString()}`)

  } catch (error) {
    res.redirect(`${FRONTEND_BASE_URL}/login?error=server_error`)
  }
}


// ── Verify email ──────────────────────────────────────────
const verifyEmail = async (req, res) => {
  try {
    const { token } = req.params
    const frontendUrl = FRONTEND_BASE_URL

    const user = await User.findOne({
      emailVerificationToken: token,
      emailVerificationExpiry: { $gt: new Date() }
    })

    if (!user) {
      return res.redirect(`${frontendUrl}/login?error=verify_link_invalid`)
    }

    user.emailVerified = true
    user.emailVerificationToken = null
    user.emailVerificationExpiry = null
    await user.save()

    return res.redirect(`${frontendUrl}/login?verified=1`)
  } catch (error) {
    const frontendUrl = FRONTEND_BASE_URL
    return res.redirect(`${frontendUrl}/login?error=verify_failed`)
  }
}

// ── Get members by language (SPOC/Admin) ────────────────
const getLanguageMembers = async (req, res) => {
  try {
    if (!['spoc', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Only SPOC/Admin can access language members' })
    }

    let targetLanguage = req.user.language
    if (req.user.role === 'admin') {
      targetLanguage = String(req.query.language || '').trim() || null
      if (!targetLanguage) {
        return res.status(400).json({ message: 'language query is required for admin' })
      }
    }

    const members = await User.find({
      language: targetLanguage,
      status: 'approved',
      isActive: true,
      role: { $ne: 'admin' }
    }).select('name email role language status isActive')

    return res.status(200).json({
      language: targetLanguage,
      members
    })
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message })
  }
}

const getAssignableMembers = async (req, res) => {
  try {
    if (!['spoc', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Only SPOC/Admin can access assignable members' })
    }

    const requestedLanguage = String(req.query.language || '').trim()
    const targetRole = String(req.query.role || '').trim()

    let targetLanguage = requestedLanguage

    if (req.user.role === 'spoc') {
      targetLanguage = String(req.user.language || '').trim()

      if (!targetLanguage) {
        return res.status(400).json({
          message: 'SPOC language is not configured. Please contact admin.'
        })
      }

      if (
        requestedLanguage &&
        normalizeLanguage(requestedLanguage) !== normalizeLanguage(req.user.language)
      ) {
        return res.status(403).json({
          message: 'SPOC can access assignable members only for their own language.'
        })
      }
    }

    if (!targetLanguage) {
      return res.status(400).json({ message: 'language query is required' })
    }

    if (targetRole && !ASSIGNABLE_MEMBER_ROLES.includes(targetRole)) {
      return res.status(400).json({ message: 'Invalid role filter' })
    }

    const roleFilter = targetRole ? [targetRole] : ASSIGNABLE_MEMBER_ROLES

    const members = await User.find({
      language: targetLanguage,
      role: { $in: roleFilter },
      status: 'approved',
      isActive: true
    }).select('name email role language status isActive')

    return res.status(200).json({
      language: targetLanguage,
      role: targetRole || null,
      members
    })
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message })
  }
}

const getMyProfile = async (req, res) => {
  try {
    const user = req.user
    if (!user) {
      return res.status(401).json({ message: 'User not found' })
    }

    return res.status(200).json({
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      language: user.language
    })
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message })
  }
}


// ── Forgot password ────────────────────────────────────────
const forgotPassword = async (req, res) => {
  try {
    const normalizedEmail = String(req.body?.email || '').trim().toLowerCase()

    if (!normalizedEmail) {
      return res.status(400).json({ message: 'Email is required' })
    }

    const user = await User.findOne({ email: normalizedEmail })
    if (!user) {
      return res.status(404).json({ message: 'No account found with this email' })
    }

    // Google users cant reset password here
    if (user.authMethod === 'google') {
      return res.status(400).json({
        message: 'This account uses Google login. Please reset password via Google.'
      })
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex')
    const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

    user.resetToken = resetToken
    user.resetTokenExpiry = resetTokenExpiry
    await user.save()

    const resetLink = `${FRONTEND_BASE_URL}/reset-password/${resetToken}`

    // Send reset email
    const mailResult = await sendMail({
      to: user.email,
      subject: 'Password Reset — Shantikunj LMS',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
          <h2 style="color: #1D9E75;">Shantikunj Audiobooks LMS</h2>
          <p>Pranam <strong>${user.name}</strong>,</p>
          <p>You requested a password reset. Click the button below:</p>
           <a href="${resetLink}"
             style="background: #1D9E75; color: white; padding: 12px 24px;
                    text-decoration: none; border-radius: 6px; display: inline-block; margin: 16px 0;">
            Reset Password
          </a>
          <p>This link expires in <strong>1 hour</strong>.</p>
          <p>If you did not request this, please ignore this email.</p>
          <p style="color: #888; font-size: 12px;">
            This is an automated message from Shantikunj LMS.
          </p>
        </div>
      `
    })

    if (!mailResult?.sent) {
      // Clear issued token when email fails to avoid storing unusable reset tokens.
      user.resetToken = null
      user.resetTokenExpiry = null
      await user.save()

      return res.status(503).json({
        message: 'Unable to send reset email right now. Please try again in a few minutes.'
      })
    }

    res.status(200).json({ message: 'Password reset link sent to your email!' })

  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// ── Reset password ─────────────────────────────────────────
const resetPassword = async (req, res) => {
  try {
    const { token } = req.params
    const normalizedPassword = String(req.body?.newPassword || '')

    if (!token) {
      return res.status(400).json({ message: 'Reset token is required' })
    }

    if (normalizedPassword.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long' })
    }

    const user = await User.findOne({
      resetToken: token,
      resetTokenExpiry: { $gt: Date.now() }
    })

    if (!user) {
      return res.status(400).json({ message: 'Reset link is invalid or has expired' })
    }

    const hashedPassword = await bcrypt.hash(normalizedPassword, 10)
    user.password = hashedPassword
    user.resetToken = null
    user.resetTokenExpiry = null
    await user.save()

    res.status(200).json({ message: 'Password reset successfully! Please login.' })

  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}




module.exports = {
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
}