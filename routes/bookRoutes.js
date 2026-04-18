const express = require('express')
const router = express.Router()
const { protect, authorise } = require('../middleware/authMiddleware')
const { uploadTranslationDoc, uploadAudioFile: uploadAudioFileMiddleware } = require('../middleware/uploadMiddleware')
const {
  addBook,
  getAllBooks,
  getBookById,
  getTextAccessUrl,
  getSourcePdfAccessUrl,
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

const bookUploadFields = [
  { name: 'bookFile', maxCount: 1 },
  { name: 'hindiPdf', maxCount: 1 },
  { name: 'sourcePdf', maxCount: 1 },
  { name: 'originalPdf', maxCount: 1 }
]

const resolveUploadedBookFile = (files = {}) => {
  const preferredFields = ['bookFile', 'hindiPdf', 'sourcePdf', 'originalPdf']

  for (const fieldName of preferredFields) {
    const file = Array.isArray(files[fieldName]) ? files[fieldName][0] : null
    if (file) {
      return file
    }
  }

  return null
}

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

const handleAudioUpload = (req, res, next) => {
  uploadAudioFileMiddleware.any()(req, res, (error) => {
    if (!error) {
      next()
      return
    }

    if (error.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ message: 'Each audio file must be 120MB or less.' })
      return
    }

    res.status(400).json({ message: error.message || 'Invalid audio upload request.' })
  })
}

const handleBookUpload = (req, res, next) => {
  uploadTranslationDoc.fields(bookUploadFields)(req, res, (error) => {
    if (!error) {
      req.file = resolveUploadedBookFile(req.files || {})
      next()
      return
    }

    if (error.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ message: 'Book file must be 20MB or less.' })
      return
    }

    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      res.status(400).json({ message: 'Please upload the file using one of these fields: bookFile, hindiPdf, sourcePdf, originalPdf.' })
      return
    }

    res.status(400).json({ message: error.message || 'Invalid book file upload request.' })
  })
}

router.use(protect)

// Admin only
router.post('/', authorise('admin'), handleBookUpload, addBook)
router.put('/:bookId/versions/:versionId/assign-unclaimed', authorise('admin', 'spoc'), assignUnclaimedVersion)
router.put('/:bookId/versions/:versionId/assign', authorise('admin', 'spoc'), assignToChecker)
router.put('/:bookId/versions/:versionId/reassign', authorise('admin', 'spoc'), reassignAfterRejections)
router.put('/:bookId/versions/:versionId/blocker', authorise('spoc'), setSpocBlocker)
router.put('/:bookId/versions/:versionId/publish', authorise('admin'), publishBook)

// All logged in users
router.get('/', getAllBooks)
router.get('/my-assignments', getMyAssignedBooks)
router.get('/:bookId/versions/:versionId/text-access-url', getTextAccessUrl)
router.get(
  '/source-pdf-access-url',
  authorise('admin', 'spoc', 'regional_team', 'translator', 'checker', 'recorder', 'audio_checker'),
  getSourcePdfAccessUrl
)
router.get(
  '/source-pdf-access-url/by-book-number/:bookNumber',
  authorise('admin', 'spoc', 'regional_team', 'translator', 'checker', 'recorder', 'audio_checker'),
  getSourcePdfAccessUrl
)
router.get(
  '/by-book-number/:bookNumber/source-pdf-access-url',
  authorise('admin', 'spoc', 'regional_team', 'translator', 'checker', 'recorder', 'audio_checker'),
  getSourcePdfAccessUrl
)
router.get(
  '/book-number/:bookNumber/source-pdf-access-url',
  authorise('admin', 'spoc', 'regional_team', 'translator', 'checker', 'recorder', 'audio_checker'),
  getSourcePdfAccessUrl
)
router.get(
  '/:bookId/source-pdf-access-url',
  authorise('admin', 'spoc', 'regional_team', 'translator', 'checker', 'recorder', 'audio_checker'),
  getSourcePdfAccessUrl
)
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
router.post('/upload-audio-file', authorise('recorder'), handleAudioUpload, uploadAudioFile)
router.post('/:bookId/versions/:versionId/submit-audio', authorise('recorder'), submitAudio)

// Audio checker submits audio review
router.post('/:bookId/versions/:versionId/submit-audio-review', authorise('audio_checker'), submitAudioReview)

// SPOC final audio approval
router.put('/:bookId/versions/:versionId/spoc-audio-approval', authorise('spoc'), spocAudioApproval)

module.exports = router