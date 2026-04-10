const express = require('express')
const router = express.Router()
const { protect, authorise } = require('../middleware/authMiddleware')
const { uploadTranslationDoc, uploadAudioFile: uploadAudioFileMiddleware } = require('../middleware/uploadMiddleware')
const {
  addBook,
  getAllBooks,
  getBookById,
  getTextAccessUrl,
  uploadTranslationDocument,
  uploadAudioFile,
  assignUnclaimedVersion,
  assignToChecker,
  reassignAfterRejections,
  setSpocBlocker,
  updateTextStatus,
  updateAudioStatus,
  getMyAssignedBooks,
  submitTranslation,
  submitVettedText,
  spocReviewText,
  submitAudio,
  submitAudioReview,
  spocAudioApproval,
  publishBook
} = require('../controllers/bookController')

const translationUploadFields = [
  { name: 'documents', maxCount: 20 },
  { name: 'document', maxCount: 1 }
]

const handleTranslationUpload = (req, res, next) => {
  uploadTranslationDoc.fields(translationUploadFields)(req, res, (error) => {
    if (!error) {
      next()
      return
    }

    if (error.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ message: 'Each document must be 20MB or less.' })
      return
    }

    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      res.status(400).json({ message: 'Please upload files using the document picker field only.' })
      return
    }

    res.status(400).json({ message: error.message || 'Invalid document upload request.' })
  })
}

router.use(protect)

// Admin only
router.post('/', authorise('admin'), addBook)
router.put('/:bookId/versions/:versionId/assign-unclaimed', authorise('admin', 'spoc'), assignUnclaimedVersion)
router.put('/:bookId/versions/:versionId/assign', authorise('admin', 'spoc'), assignToChecker)
router.put('/:bookId/versions/:versionId/reassign', authorise('admin', 'spoc'), reassignAfterRejections)
router.put('/:bookId/versions/:versionId/blocker', authorise('spoc'), setSpocBlocker)
router.put('/:bookId/versions/:versionId/publish', authorise('admin'), publishBook)

// All logged in users
router.get('/', getAllBooks)
router.get('/my-assignments', getMyAssignedBooks)
router.get('/:bookId/versions/:versionId/text-access-url', getTextAccessUrl)
router.get('/:bookId', getBookById)

// Status updates (manual)
router.put('/:bookId/versions/:versionId/text-status', authorise('admin', 'spoc'), updateTextStatus)
router.put('/:bookId/versions/:versionId/audio-status', authorise('admin', 'spoc'), updateAudioStatus)

// Translator submits
router.post(
  '/upload-translation-doc',
  authorise('translator'),
  handleTranslationUpload,
  uploadTranslationDocument
)
router.post('/:bookId/versions/:versionId/submit-translation', authorise('translator'), submitTranslation)

// Checker submits vetted text
router.post('/:bookId/versions/:versionId/submit-vetted-text', authorise('checker'), submitVettedText)

// SPOC reviews text
router.put('/:bookId/versions/:versionId/spoc-review', authorise('spoc'), spocReviewText)

// Recorder submits audio
router.post('/upload-audio-file', authorise('recorder'), uploadAudioFileMiddleware.any(), uploadAudioFile)
router.post('/:bookId/versions/:versionId/submit-audio', authorise('recorder'), submitAudio)

// Audio checker submits audio review
router.post('/:bookId/versions/:versionId/submit-audio-review', authorise('audio_checker'), submitAudioReview)

// SPOC final audio approval
router.put('/:bookId/versions/:versionId/spoc-audio-approval', authorise('spoc'), spocAudioApproval)

module.exports = router