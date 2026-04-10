const express = require('express')
const router = express.Router()
const { protect, authorise } = require('../middleware/authMiddleware')
const {
  submitFeedback,
  getFeedbackList,
  getFeedbackSummary,
  getMyFeedbackFeed
} = require('../controllers/feedbackController')

router.use(protect)

router.post('/books/:bookId/versions/:versionId', submitFeedback)
router.get('/my', authorise('translator'), getMyFeedbackFeed)
router.get('/books/:bookId/versions/:versionId', authorise('admin', 'spoc', 'translator', 'checker', 'audio_checker', 'recorder', 'regional_team'), getFeedbackList)
router.get('/books/:bookId/versions/:versionId/summary', authorise('admin', 'spoc', 'translator', 'checker', 'audio_checker', 'recorder', 'regional_team'), getFeedbackSummary)

module.exports = router
