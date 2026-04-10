const fs = require('fs');
const path = require('path');

const createTestFile = (filePath) => {
  fs.writeFileSync(filePath, 'This is a test translation document for Cloudinary upload.', 'utf8');
};

const login = async () => {
  const response = await fetch('http://localhost:5000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'testtranslator@shantikunj.com', password: 'Test@1234' })
  });
  return response.json();
};

const uploadFile = async (token, filePath) => {
  const form = new FormData();
  const fileBuffer = fs.readFileSync(filePath);
  const fileBlob = new Blob([fileBuffer]);
  form.append('documents', fileBlob, 'test-document.txt');

  const response = await fetch('http://localhost:5000/api/books/upload-translation-doc', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
  return response.json();
};

(async () => {
  try {
    const filePath = path.resolve(__dirname, 'test-document.txt');
    createTestFile(filePath);
    console.log('Test file created:', filePath);

    const loginResult = await login();
    console.log('Login result:', loginResult);
    if (!loginResult.token) {
      throw new Error('Login failed');
    }

    const uploadResult = await uploadFile(loginResult.token, filePath);
    console.log('Upload result:', uploadResult);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
})();