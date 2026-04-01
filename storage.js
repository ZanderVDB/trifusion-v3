// ─── Cloudflare R2 Storage ────────────────────────────────────────────────────
// R2 is S3-compatible so we use the AWS SDK
// Falls back to local disk storage if R2 is not configured
// File structure: {companyId}/{jobId}/{filename}

const fs   = require('fs');
const path = require('path');

const R2_CONFIGURED = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET
);

let s3Client, BUCKET;

if (R2_CONFIGURED) {
  const { S3Client } = require('@aws-sdk/client-s3');
  BUCKET = process.env.R2_BUCKET;
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  console.log('[R2] Cloud storage enabled ✓');
} else {
  console.log('[R2] Not configured — using local disk storage');
}

// Upload a file buffer to R2 or local disk
// key structure: companyId/jobId/filename
async function uploadFile(companyId, jobId, filename, buffer, mimetype) {
  if (R2_CONFIGURED) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const key = `${companyId}/${jobId}/${filename}`;
    await s3Client.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key:    key,
      Body:   buffer,
      ContentType: mimetype || 'application/octet-stream',
    }));
    // Use public URL if configured, otherwise serve via proxy route
    const base = process.env.R2_PUBLIC_URL || '';
    const url  = base ? `${base}/${key}` : `/r2/${key}`;
    return { key, url };
  } else {
    // Local fallback
    const dir = path.join(__dirname, 'uploads', companyId, jobId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), buffer);
    return { key: `${companyId}/${jobId}/${filename}`, url: `/uploads/${companyId}/${jobId}/${filename}` };
  }
}

// Delete a file from R2 or local disk
async function deleteFile(companyId, jobId, filename) {
  if (R2_CONFIGURED) {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await s3Client.send(new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: `${companyId}/${jobId}/${filename}`
    }));
  } else {
    const filePath = path.join(__dirname, 'uploads', companyId, jobId, filename);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(e) {}
  }
}

// Proxy a file from R2 (for private buckets without public URL)
async function getFileStream(key) {
  if (R2_CONFIGURED) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const res = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return { stream: res.Body, contentType: res.ContentType };
  }
  return null;
}

module.exports = { uploadFile, deleteFile, getFileStream, R2_CONFIGURED };
