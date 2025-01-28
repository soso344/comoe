require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { exec } = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const { spawn } = require("child_process");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HANDBRAKE_CLI_PATH = process.env.HANDBRAKE_CLI_PATH || "HandBrakeCLI";
const TMP_DIR = os.tmpdir();
const API_PORT = process.env.API_PORT || 8081;
const BOT_PORT = process.env.BOT_PORT || 7860;

// Function to start the Telegram API server
function startTelegramServer() {
  return new Promise((resolve, reject) => {
    const serverProcess = spawn("./telegram-bot-api", [
      "--api-id",
      process.env.TELEGRAM_API_ID,
      "--api-hash",
      process.env.TELEGRAM_API_HASH,
      "--dir", "/tmp",
      "--verbosity", "3",
      "--local"
    ]);

    // Add process validation
    const startupTimeout = setTimeout(() => {
      serverProcess.kill();
      reject(new Error(`API server failed to start within 30s. Last log: ${lastLog}`));
    }, 30000);

    let lastLog = '';
    
    serverProcess.stdout.on("data", (data) => {
      lastLog = data.toString();
      console.log(`[API] ${lastLog}`);
      if (lastLog.includes("Listening")) {
        clearTimeout(startupTimeout);
        resolve(serverProcess);
      }
    });

    serverProcess.stderr.on("data", (data) => {
      lastLog = data.toString();
      console.error(`[API Error] ${lastLog}`);
    });
  });
}


// Modified bot code to use local API server
const TELEGRAM_API = `http://localhost:${API_PORT}/bot${TOKEN}`;

// Rest of your existing code remains the same, just update the API endpoint
const app = express();
app.use(express.json());

class SimpleQueue {
  constructor() {
    this.processing = false;
    this.queue = [];
  }

  async add(task) {
    this.queue.push(task);
    this.processNext();
  }

  async processNext() {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    const task = this.queue.shift();

    try {
      await task();
    } catch (error) {
      console.error("Task processing error:", error);
    }

    this.processing = false;
    this.processNext();
  }
}

// Progress parsing utilities
function parseHandBrakeProgress(data) {
  const progressMatch = data.toString().match(/Encoding: task 1 of 1, (.+) %/);
  if (progressMatch) {
    return {
      type: "progress",
      percent: parseFloat(progressMatch[1]).toFixed(1),
    };
  }

  // Parse encoding stats
  const fpsMatch = data.toString().match(/([0-9.]+) fps/);
  const avgSpeedMatch = data
    .toString()
    .match(/average encoding speed for job is ([0-9.]+) fps/);
  if (fpsMatch || avgSpeedMatch) {
    return {
      type: "speed",
      fps: fpsMatch ? parseFloat(fpsMatch[1]).toFixed(1) : null,
      avgFps: avgSpeedMatch ? parseFloat(avgSpeedMatch[1]).toFixed(1) : null,
    };
  }

  // Parse time remaining estimate
  const timeMatch = data.toString().match(/ETA ([0-9hms]+)/);
  if (timeMatch) {
    return {
      type: "eta",
      time: timeMatch[1],
    };
  }

  return null;
}

// Progress tracking class
class CompressionProgress {
  constructor(chatId) {
    this.chatId = chatId;
    this.lastProgressUpdate = 0;
    this.lastProgressPercent = 0;
    this.lastMessageId = null;
    this.startTime = Date.now();
  }

  async updateProgress(progress) {
    // Update at most every 5 seconds and only if progress changed by at least 5%
    const now = Date.now();
    if (
      now - this.lastProgressUpdate > 5000 &&
      (progress.percent - this.lastProgressPercent >= 5 ||
        progress.percent === 100)
    ) {
      const elapsedMinutes = ((now - this.startTime) / 60000).toFixed(1);
      const message = `Compression Progress: ${progress.percent}%
Time elapsed: ${elapsedMinutes} minutes`;

      try {
        if (this.lastMessageId) {
          // Edit existing message
          await axios.post(`${TELEGRAM_API}/editMessageText`, {
            chat_id: this.chatId,
            message_id: this.lastMessageId,
            text: message,
          });
        } else {
          // Send new message
          const response = await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: this.chatId,
            text: message,
          });
          this.lastMessageId = response.data.result.message_id;
        }

        this.lastProgressUpdate = now;
        this.lastProgressPercent = progress.percent;
      } catch (error) {
        console.error("Error updating progress message:", error);
      }
    }
  }
}

async function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    const ffprobe = exec(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
    );
    let duration = "";

    ffprobe.stdout.on("data", (data) => {
      duration += data.toString();
    });

    ffprobe.on("exit", (code) => {
      if (code === 0) {
        resolve(parseFloat(duration));
      } else {
        reject(new Error("Failed to get video duration"));
      }
    });
  });
}

function downloadVideo(url) {
  return new Promise(async (resolve, reject) => {
    try {
      console.log(`Downloading video from: ${url}`);
      const fileName = `video_${Date.now()}.mp4`;
      const filePath = path.join(TMP_DIR, fileName);

      const response = await axios({
        url,
        method: "GET",
        responseType: "stream",
        maxRedirects: 5,
        timeout: 30000,
        validateStatus: (status) => status >= 200 && status < 400,
      });

      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);

      writer.on("finish", () => {
        console.log(`Finished downloading video: ${filePath}`);
        resolve(filePath);
      });

      writer.on("error", (error) => {
        console.error(`Error downloading video: ${error.message}`);
        reject(error);
      });
    } catch (error) {
      console.error(`Error initiating download: ${error.message}`);
      reject(error);
    }
  });
}

function compressVideo(inputPath, chatId) {
  return new Promise(async (resolve, reject) => {
    try {
      const duration = await getVideoDuration(inputPath);
      const timeoutMinutes = Math.min(
        Math.max(Math.ceil(duration / 60) * 3, 10),
        120,
      );
      const timeoutMs = timeoutMinutes * 60 * 1000;

      const compressedPath = inputPath.replace(".mp4", "_compressed.mp4");
      console.log(
        `Starting compression for: ${inputPath} with ${timeoutMinutes} minutes timeout`,
      );

      const args = [
        "-i",
        `"${inputPath}"`,
        "-o",
        `"${compressedPath}"`,
        "--format",
        "mp4",
        "--encoder",
        "x264",
        "--quality",
        "22",
        "--optimize",
        "--width",
        "854",
        "--height",
        "480",
        "--aencoder",
        "copy:aac",
        "--audio",
        "1",
        "--preset",
        "faster",
      ];

      const command = `${HANDBRAKE_CLI_PATH} ${args.join(" ")}`;
      const process = exec(command);
      let lastProgress = Date.now();
      let stuck = false;

      // Initialize progress tracker
      const progressTracker = new CompressionProgress(chatId);

      process.stdout.on("data", (data) => {
        const progress = parseHandBrakeProgress(data);
        if (progress) {
          if (progress.type === "progress") {
            progressTracker.updateProgress(progress);
          }
          lastProgress = Date.now();
        }
      });

      process.stderr.on("data", (data) => {
        // Only log actual errors, not HandBrake's status messages
        if (
          !data.toString().includes("Encoding:") &&
          !data.toString().includes("sync:") &&
          !data.toString().includes("work:")
        ) {
          console.error(`Compression error: ${data}`);
        }
        lastProgress = Date.now();
      });

      // Monitor for process getting stuck
      const progressCheck = setInterval(() => {
        const timeSinceLastProgress = Date.now() - lastProgress;
        if (timeSinceLastProgress > 300000) {
          // 5 minutes without progress
          stuck = true;
          process.kill();
          clearInterval(progressCheck);
          reject(
            new Error("Compression appears stuck - no progress for 5 minutes"),
          );
        }
      }, 60000);

      process.on("exit", async (code) => {
        clearInterval(progressCheck);
        if (code === 0 && !stuck) {
          // Send completion message
          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: `Compression complete! Final file size: ${(fs.statSync(compressedPath).size / (1024 * 1024)).toFixed(2)} MB`,
          });
          resolve(compressedPath);
        } else if (!stuck) {
          reject(new Error(`Compression failed with code ${code}`));
        }
      });

      // Add timeout based on video duration
      setTimeout(() => {
        clearInterval(progressCheck);
        process.kill();
        reject(
          new Error(`Compression timeout after ${timeoutMinutes} minutes`),
        );
      }, timeoutMs);
    } catch (error) {
      reject(error);
    }
  });
}

async function processVideo(url, chatId) {
  let downloadedPath, compressedPath;
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `Starting to process video from: ${url}`,
    });

    downloadedPath = await downloadVideo(url);
    console.log(`Downloaded video to: ${downloadedPath}`);

    const duration = await getVideoDuration(downloadedPath);
    const durationMinutes = Math.ceil(duration / 60);
    const originalSize = (
      fs.statSync(downloadedPath).size /
      (1024 * 1024)
    ).toFixed(2);

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text:
        `✅ Download complete
` +
        `📊 Video info:
` +
        `• Duration: ${durationMinutes} minutes
` +
        `• Size: ${originalSize} MB
` +
        `Starting compression...`,
    });

    compressedPath = await compressVideo(downloadedPath, chatId);

    const formData = new FormData();
    formData.append("chat_id", chatId);
    formData.append("document", fs.createReadStream(compressedPath));

    await axios.post(`${TELEGRAM_API}/sendDocument`, formData, {
      headers: formData.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
  } catch (error) {
    console.error("Error processing video:", error);
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `❌ Failed to process video: ${error.message}. Please try again or try with a shorter video.`,
    });
  } finally {
    // Cleanup code remains the same
    try {
      if (downloadedPath && fs.existsSync(downloadedPath))
        fs.unlinkSync(downloadedPath);
      if (compressedPath && fs.existsSync(compressedPath))
        fs.unlinkSync(compressedPath);
    } catch (cleanupError) {
      console.error("Error cleaning up files:", cleanupError);
    }
  }
}

const videoQueue = new SimpleQueue();

app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;
    console.log("Received update:", JSON.stringify(update));

    if (update.message?.text) {
      const chatId = update.message.chat.id;
      const text = update.message.text;
      const urls = text.match(/(https?:\/\/[^\s]+)/gi);

      if (urls?.length > 0) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `Found ${urls.length} URL(s). They will be processed one by one.`,
        });

        // Add each URL to the queue
        for (const url of urls) {
          videoQueue.add(() => processVideo(url, chatId));
        }
      } else {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "No valid URLs found in your message.",
        });
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.sendStatus(500);
  }
});

// Start both servers
async function startServers() {
  try {
    console.log("Starting API server...");
    const apiProcess = await startTelegramServer();
    
    console.log("Starting web server...");
    app.listen(BOT_PORT, () => {
      console.log(`Unified server running on port ${BOT_PORT}`);
      
      // Add health check endpoint
      app.get('/health', (req, res) => {
        res.json({
          status: 'ok',
          telegram_api: apiProcess.pid ? 'running' : 'stopped',
          memory: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`
        });
      });
    });

  } catch (error) {
    console.error("Fatal startup error:", error);
    process.exit(1);
  }
}

startServers();
