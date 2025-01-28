// app.js
document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("compressionForm");
  const videoUrlInput = document.getElementById("videoUrl");
  const submitBtn = document.getElementById("submitBtn");
  const progressContainer = document.getElementById("progressContainer");
  const progressBarFill = document.getElementById("progressBarFill");
  const statusText = document.getElementById("statusText");
  const progressPercentage = document.getElementById("progressPercentage");
  const compressionStats = document.getElementById("compressionStats");
  const originalSize = document.getElementById("originalSize");
  const compressedSize = document.getElementById("compressedSize");
  const compressionRatio = document.getElementById("compressionRatio");
  const downloadLink = document.getElementById("downloadLink");
  const errorContainer = document.getElementById("errorContainer");
  const reconnectingMessage = document.getElementById("reconnectingMessage");

  let ws;

  const initializeWebSocket = () => {
    ws = new WebSocket("wss://elghamazy-comoe.hf.space");

    ws.onopen = () => {
      reconnectingMessage.classList.remove("visible");
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.status) {
        statusText.textContent = capitalizeFirstLetter(data.status);
      }

      if (data.progress) {
        progressBarFill.style.width = `${data.progress}%`;
        progressPercentage.textContent = `${data.progress.toFixed(2)}%`;
      }

      if (data.status === "complete" && data.downloadLink) {
        downloadLink.href = data.downloadLink;
        downloadLink.classList.add("visible");
        progressContainer.classList.remove("visible");
        statusText.textContent = "Compression complete!";
      }

      if (data.status === "error") {
        showError(data.error);
      }
    };

    ws.onclose = () => {
      reconnectingMessage.classList.add("visible");
      setTimeout(initializeWebSocket, 5000); // Retry connection every 5 seconds
    };
  };

  const capitalizeFirstLetter = (string) =>
    string.charAt(0).toUpperCase() + string.slice(1);

  const showError = (message) => {
    errorContainer.textContent = message;
    errorContainer.classList.add("visible");
    setTimeout(() => {
      errorContainer.classList.remove("visible");
    }, 5000);
  };

  const startCompression = async (url) => {
    try {
      submitBtn.disabled = true;
      progressContainer.classList.add("visible");
      statusText.textContent = "Initializing...";
      progressBarFill.style.width = "0%";
      progressPercentage.textContent = "0%";
      downloadLink.classList.remove("visible");

      // Send compression task to the server via WebSocket
      ws.send(JSON.stringify({ url }));

      // No need to wait for response; updates will come via WebSocket
    } catch (error) {
      showError("Failed to start compression. Please try again.");
    } finally {
      submitBtn.disabled = false;
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const videoUrl = videoUrlInput.value.trim();
    if (!videoUrl) {
      showError("Please provide a valid video URL.");
      return;
    }

    startCompression(videoUrl);
  });

  // Initialize WebSocket connection
  initializeWebSocket();
});
