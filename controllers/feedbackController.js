const Book = require('../models/Book')
const Feedback = require('../models/Feedback')
const { logAudit } = require('../services/auditService')

const canSubmitFeedbackRole = (role) => {
  return ['regional_team', 'translator', 'checker', 'audio_checker', 'recorder', 'spoc'].includes(role)
}

const isSameUserId = (value, userId) => {
  if (!value || !userId) return false
  return value.toString() === userId.toString()
}

const canViewFeedbackForVersion = (user, version) => {
  if (!user || !version) return false

  if (user.role === 'admin') return true
  if (user.role === 'spoc') return user.language === version.language
  if (user.role === 'translator') return isSameUserId(version.assignedTranslator, user._id)

  if (user.role === 'checker') {
    return isSameUserId(version.assignedChecker, user._id)
  }

  if (user.role === 'audio_checker') return isSameUserId(version.assignedAudioChecker, user._id)

  if (user.role === 'recorder') return isSameUserId(version.assignedRecorder, user._id)
  if (user.role === 'regional_team') return user.language === version.language

  return false
}

const submitFeedback = async (req, res) => {
  try {
    const { bookId, versionId } = req.params
    const { rating, text } = req.body

    if (!canSubmitFeedbackRole(req.user.role)) {
      return res.status(403).json({ message: 'Your role cannot submit feedback' })
    }

    const parsedRating = Number(rating)
    if (!Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 5) {
      return res.status(400).json({ message: 'Rating must be an integer between 1 and 5' })
    }

    if (!text || !text.trim()) {
      return res.status(400).json({ message: 'Feedback text is required' })
    }

    const book = await Book.findById(bookId)
    if (!book) return res.status(404).json({ message: 'Book not found' })

    const version = book.languageVersions.id(versionId)
    if (!version) return res.status(404).json({ message: 'Language version not found' })

    if (req.user.language !== version.language) {
      return res.status(403).json({ message: 'You can only submit feedback for your own language' })
    }

    if (version.audioStatus !== 'audio_approved') {
      return res.status(400).json({ message: 'Feedback is allowed only after SPOC audio approval' })
    }

    if (!version.feedbackDeadline) {
      return res.status(400).json({ message: 'Feedback window is not opened yet' })
    }

    if (new Date() > new Date(version.feedbackDeadline)) {
      return res.status(400).json({ message: 'Feedback window is closed for this version' })
    }

    const feedback = await Feedback.findOneAndUpdate(
      {
        book: bookId,
        versionId,
        reviewer: req.user._id
      },
      {
        language: version.language,
        rating: parsedRating,
        text: text.trim()
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true
      }
    )

    await logAudit({
      req,
      action: 'feedback_submitted',
      entityType: 'feedback',
      entityId: feedback._id,
      book: book._id,
      versionId,
      language: version.language,
      metadata: { rating: parsedRating }
    })

    return res.status(200).json({
      message: 'Feedback submitted successfully',
      feedback
    })
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message })
  }
}

const getFeedbackList = async (req, res) => {
  try {
    const { bookId, versionId } = req.params

    const book = await Book.findById(bookId)
    if (!book) return res.status(404).json({ message: 'Book not found' })

    const version = book.languageVersions.id(versionId)
    if (!version) return res.status(404).json({ message: 'Language version not found' })

    if (!canViewFeedbackForVersion(req.user, version)) {
      return res.status(403).json({ message: 'You are not allowed to view feedback for this version' })
    }

    const feedbackList = await Feedback.find({ book: bookId, versionId })
      .populate('reviewer', 'name email role language')
      .sort({ createdAt: -1 })

    return res.status(200).json(feedbackList)
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message })
  }
}

const getFeedbackSummary = async (req, res) => {
  try {
    const { bookId, versionId } = req.params

    const book = await Book.findById(bookId)
    if (!book) return res.status(404).json({ message: 'Book not found' })

    const version = book.languageVersions.id(versionId)
    if (!version) return res.status(404).json({ message: 'Language version not found' })

    if (!canViewFeedbackForVersion(req.user, version)) {
      return res.status(403).json({ message: 'You are not allowed to view feedback summary for this version' })
    }

    const summary = await Feedback.aggregate([
      {
        $match: {
          book: Book.db.base.Types.ObjectId.createFromHexString(bookId),
          versionId: Book.db.base.Types.ObjectId.createFromHexString(versionId)
        }
      },
      {
        $group: {
          _id: null,
          totalFeedback: { $sum: 1 },
          avgRating: { $avg: '$rating' },
          minRating: { $min: '$rating' },
          maxRating: { $max: '$rating' }
        }
      }
    ])

    return res.status(200).json(summary[0] || {
      totalFeedback: 0,
      avgRating: null,
      minRating: null,
      maxRating: null
    })
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message })
  }
}

const getMyFeedbackFeed = async (req, res) => {
  try {
    if (req.user.role !== 'translator') {
      return res.status(403).json({ message: 'Only translators can access personal feedback feed' })
    }

    const feedbackList = await Feedback.find({
      language: req.user.language
    })
      .populate('reviewer', 'name email role language')
      .sort({ createdAt: -1 })

    const languageBooks = await Book.find({
      'languageVersions.language': req.user.language
    }).select('title languageVersions._id languageVersions.language languageVersions.feedback languageVersions.blockerNote languageVersions.updatedAt')

    const uniqueBookIds = [...new Set(
      feedbackList
        .map((entry) => entry.book?.toString())
        .filter(Boolean)
    )]

    const books = await Book.find({
      _id: { $in: uniqueBookIds }
    }).select('title')

    const titleByBookId = new Map(
      books.map((book) => [book._id.toString(), book.title])
    )

    const enriched = feedbackList.map((entry) => {
      const bookId = entry.book?.toString() || ''

      return {
        ...entry.toObject(),
        entryType: 'formal_feedback',
        bookTitle: titleByBookId.get(bookId) || 'Unknown Book',
        language: entry.language,
        bookId: entry.book,
        versionId: entry.versionId
      }
    })

    const workflowNotes = []

    languageBooks.forEach((book) => {
      ;(book.languageVersions || []).forEach((version) => {
        if (version.language !== req.user.language) return

        const feedbackText = String(version.feedback || '').trim()
        const blockerText = String(version.blockerNote || '').trim()
        if (!feedbackText && !blockerText) return

        const noteParts = []
        if (feedbackText) noteParts.push(feedbackText)
        if (blockerText) noteParts.push(`Blocker: ${blockerText}`)

        workflowNotes.push({
          _id: `workflow-${book._id.toString()}-${version._id.toString()}`,
          entryType: 'workflow_note',
          book: book._id,
          bookId: book._id,
          versionId: version._id,
          bookTitle: book.title,
          language: version.language,
          rating: null,
          text: noteParts.join(' | '),
          reviewer: null,
          createdAt: version.updatedAt || new Date(0)
        })
      })
    })

    const merged = [...enriched, ...workflowNotes].sort((a, b) => {
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    })

    return res.status(200).json(merged)
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message })
  }
}

module.exports = {
  submitFeedback,
  getFeedbackList,
  getFeedbackSummary,
  getMyFeedbackFeed
}
