// One-time mic permission prompt for the extension origin.
// The stream is stopped immediately; nothing is recorded.
document.getElementById('grant').addEventListener('click', async () => {
  const msg = document.getElementById('msg');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    msg.textContent = 'Done. You can close this tab and start captions from the popup.';
    setTimeout(() => window.close(), 1500);
  } catch (err) {
    msg.textContent = `Permission was not granted (${err.name}). Check Chrome's site settings for this extension.`;
  }
});
