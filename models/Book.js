const mongoose = require('mongoose')

const languageVersionSchema = new mongoose.Schema({
  language: {
    type: String,
    required: true
  },
  translatedText: {
    type: String,
    default: null
  },

  // ── Text status ──────────────────────────────────────────
  textStatus: {
    type: String,
    enum: [
      'not_started',
      'translation_in_progress',
      'translation_submitted',
      'checking_in_progress',
      'checking_submitted',
      'spoc_review',
      'text_approved',
      'rejected'
    ],
    default: 'not_started'
  },

  // ── Audio status ─────────────────────────────────────────
  audioStatus: {
    type: String,
    enum: [
      'not_started',
      'audio_generated',
      'audio_submitted',
      'audio_checking_in_progress',
      'audio_checking_submitted',
      'issues_found',
      'audio_approved',
      'published'
    ],
    default: 'not_started'
  },

  // ── Translator assignment ────────────────────────────────
  assignedTranslator: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  translatorDeadline: {
    type: Date,
    default: null
  },

  // ── Checker assignment ───────────────────────────────────
  assignedChecker: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  checkerDeadline: {
    type: Date,
    default: null
  },
  lastCheckedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  lastCheckedAt: {
    type: Date,
    default: null
  },
  checkerApprovedAt: {
    type: Date,
    default: null
  },
  checkerRevisionSentAt: {
    type: Date,
    default: null
  },

  // ── SPOC ─────────────────────────────────────────────────
  spoc: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },

  // ── Audio assignments ────────────────────────────────────
  assignedRecorder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  recorderDeadline: {
    type: Date,
    default: null
  },
  assignedAudioChecker: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  audioCheckerDeadline: {
    type: Date,
    default: null
  },

  // ── Claim/lock system ────────────────────────────────────
  isLocked: {
    type: Boolean,
    default: false
  },
  lockedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  lockedUntil: {
    type: Date,
    default: null
  },
  interestEmailSent: {
    type: Boolean,
    default: false
  },
  interestEmailSentAt: {
    type: Date,
    default: null
  },

  // ── Feedback and tracking ────────────────────────────────
  feedback: {
    type: String,
    default: null
  },
  audioUrl: {
    type: String,
    default: null
  },
  audioFiles: {
    type: [String],
    default: []
  },
  textFileUrl: {
    type: String,
    default: null
  },
  textFileUrls: {
    type: [String],
    default: []
  },
  publishedTextFileUrl: {
    type: String,
    default: null
  },
  publishedTextFileUrls: {
    type: [String],
    default: []
  },
  publishedTranslatedText: {
    type: String,
    default: null
  },
  publishedAudioUrl: {
    type: String,
    default: null
  },
  publishedAudioFiles: {
    type: [String],
    default: []
  },
  publishedAt: {
    type: Date,
    default: null
  },
  publishedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  reassignmentCount: {
    type: Number,
    default: 0
  },
  textRejectionCount: {
    type: Number,
    default: 0
  },
  audioRejectionCount: {
    type: Number,
    default: 0
  },
  feedbackDeadline: {
    type: Date,
    default: null
  },
  isBlockedBySpoc: {
    type: Boolean,
    default: false
  },
  blockerNote: {
    type: String,
    default: null
  },
  currentStage: {
    type: String,
    enum: [
      'translation',
      'checking',
      'spoc_review',
      'audio_generation',
      'audio_checking',
      'final_verification',
      'published'
    ],
    default: 'translation'
  }

}, { timestamps: true })

const bookSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  bookNumber: {
    type: Number,
    required: true,
    unique: true          // 1 to 12
  },
  description: {
    type: String,
    default: null
  },
  originalPdfUrl: {
    type: String,
    default: null         // Hindi PDF stored here
  },
  languageVersions: [languageVersionSchema],
  status: {
    type: String,
    enum: ['active', 'completed', 'on_hold'],
    default: 'active'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { timestamps: true })

module.exports = mongoose.model('Book', bookSchema)