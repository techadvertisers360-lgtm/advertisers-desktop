const { API_BASE_URL } = require("./config");

async function uploadScreenshot(accessToken, jpegBuffer, capturedAt) {
  const form = new FormData();
  form.append(
    "screenshot",
    new Blob([jpegBuffer], { type: "image/jpeg" }),
    `screenshot-${capturedAt.getTime()}.jpg`,
  );
  form.append("capturedAt", capturedAt.toISOString());

  const res = await fetch(`${API_BASE_URL}/screenshots`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });

  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    const error = new Error(body?.message || `Upload failed with status ${res.status}`);
    error.status = res.status;
    throw error;
  }

  return body.data; // { id, captured_at }
}

module.exports = { uploadScreenshot };
