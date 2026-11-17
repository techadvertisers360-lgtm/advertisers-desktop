const { desktopCapturer, screen } = require("electron");

// JPEG rather than PNG: a full-resolution PNG is often 2-5MB, which would
// blow past the backend host's ~4.5MB request limit; JPEG at this quality
// is typically 200-600KB and still perfectly readable.
const JPEG_QUALITY = 70;

async function captureScreenshotBuffer() {
  const display = screen.getPrimaryDisplay();
  const scaleFactor = display.scaleFactor || 1;
  const width = Math.round(display.size.width * scaleFactor);
  const height = Math.round(display.size.height * scaleFactor);

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width, height },
  });

  if (sources.length === 0) {
    throw new Error("No screen sources available to capture");
  }

  const image = sources[0].thumbnail;
  if (image.isEmpty()) {
    // Typical on macOS when Screen Recording permission hasn't been granted.
    throw new Error("Captured image is empty (screen recording permission missing?)");
  }

  return image.toJPEG(JPEG_QUALITY);
}

module.exports = { captureScreenshotBuffer };
