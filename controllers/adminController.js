const User = require('../models/User')
const { normalizeTranslationLanguage } = require('../constants/languages')

// ── Get all pending users ──────────────────────────────────
const getPendingUsers = async (req, res) => {
  try {
    const users = await User.find({ status: 'pending' })
      .select('-password')
    res.status(200).json(users)
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// ── Approve user + assign role ─────────────────────────────
const approveUser = async (req, res) => {
  try {
    const { userId } = req.params
    const { role, language } = req.body || {}

    const existing = await User.findById(userId)
    if (!existing) {
      return res.status(404).json({ message: 'User not found' })
    }

    const finalRole = role || existing.requestedRole || 'translator'
    const languageInput = language || existing.requestedLanguage || 'English'
    const finalLanguage = normalizeTranslationLanguage(languageInput)

    if (finalRole === 'admin' || finalRole === 'pending') {
      return res.status(400).json({ message: 'Cannot approve user with this role' })
    }

    if (!finalLanguage) {
      return res.status(400).json({ message: 'Cannot approve user with unsupported language' })
    }

    const user = await User.findByIdAndUpdate(
      userId,
      {
        role: finalRole,
        language: finalLanguage,
        requestedRole: null,
        requestedLanguage: null,
        status: 'approved',
        isActive: true,
        approvedBy: req.user._id,
        approvedAt: new Date()
      },
      { new: true }
    ).select('-password')

    if (!user) {
      return res.status(404).json({ message: 'User not found' })
    }

    res.status(200).json({ 
      message: `User approved as ${finalRole}`, 
      user 
    })

  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// ── Reject user ────────────────────────────────────────────
const rejectUser = async (req, res) => {
  try {
    const { userId } = req.params

    const user = await User.findByIdAndUpdate(
      userId,
      { status: 'rejected', isActive: false },
      { new: true }
    ).select('-password')

    if (!user) {
      return res.status(404).json({ message: 'User not found' })
    }

    res.status(200).json({ message: 'User rejected', user })

  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// ── Get all users ──────────────────────────────────────────
const getAllUsers = async (req, res) => {
  try {
    const users = await User.find().select('-password')
    res.status(200).json(users)
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// ── Delete a user (admin only) ───────────────────────────
const deleteUser = async (req, res) => {
  try {
    const { userId } = req.params

    if (String(req.user._id) === String(userId)) {
      return res.status(400).json({ message: 'You cannot delete your own account' })
    }

    const user = await User.findById(userId)
    if (!user) {
      return res.status(404).json({ message: 'User not found' })
    }

    if (user.role === 'admin') {
      return res.status(400).json({ message: 'Admin accounts cannot be deleted from this action' })
    }

    await User.findByIdAndDelete(userId)
    res.status(200).json({ message: 'User deleted successfully' })
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

module.exports = { getPendingUsers, approveUser, rejectUser, getAllUsers, deleteUser }