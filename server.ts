/**
 * Bun Text-to-Speech Starter - Backend Server
 *
 * This is a simple Bun HTTP server that provides a text-to-speech API endpoint
 * powered by Deepgram's Text-to-Speech service. It's designed to be easily
 * modified and extended for your own projects.
 *
 * Key Features:
 * - Contract-compliant API endpoint: POST /api/text-to-speech
 * - Accepts text in body and model as query parameter
 * - Returns binary audio data (audio/mpeg)
 * - JWT session auth for API protection
 * - CORS enabled for frontend communication
 * - Native TypeScript support via Bun runtime
 */

import { DeepgramClient } from "@deepgram/sdk";
import * as fs from "fs";
import jwt from "jsonwebtoken";
import * as path from "path";
import TOML from "@iarna/toml";

// ============================================================================
// CONFIGURATION - Customize these values for your needs
// ============================================================================

/**
 * Default text-to-speech model to use when none is specified
 * Options: "aura-2-thalia-en", "aura-2-theia-en", "aura-2-andromeda-en", etc.
 * See: https://developers.deepgram.com/docs/text-to-speech-models
 */
const DEFAULT_MODEL = "aura-2-thalia-en";

/**
 * Server configuration - These can be overridden via environment variables
 */
interface ServerConfig {
  port: number;
  host: string;
}

const config: ServerConfig = {
  port: parseInt(process.env.PORT || "8081"),
  host: process.env.HOST || "0.0.0.0",
};

// ============================================================================
// SESSION AUTH - JWT tokens for API protection
// ============================================================================

/**
 * Session secret for signing JWTs.
 * Auto-generated in development, should be set via env var in production.
 */
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");

/** JWT expiry time (1 hour) */
const JWT_EXPIRY = "1h";

// ============================================================================
// API KEY LOADING - Load Deepgram API key from environment
// ============================================================================

/**
 * Loads the Deepgram API key from environment variables or config.json
 * Priority: DEEPGRAM_API_KEY env var > config.json > error
 * @returns {string} The Deepgram API key
 */
function loadApiKey(): string {
  // Try environment variable first (recommended)
  let apiKey = process.env.DEEPGRAM_API_KEY;

  // Fall back to config.json if it exists
  if (!apiKey) {
    try {
      const configPath = path.join(import.meta.dir, "config.json");
      const configFile = fs.readFileSync(configPath, "utf-8");
      const configData = JSON.parse(configFile);
      apiKey = configData.dgKey;
    } catch {
      // config.json doesn't exist or is invalid - that's ok
    }
  }

  // Exit with helpful error if no API key found
  if (!apiKey) {
    console.error("\n\u274C ERROR: Deepgram API key not found!\n");
    console.error("Please set your API key using one of these methods:\n");
    console.error("1. Create a .env file (recommended):");
    console.error("   DEEPGRAM_API_KEY=your_api_key_here\n");
    console.error("2. Environment variable:");
    console.error("   export DEEPGRAM_API_KEY=your_api_key_here\n");
    console.error("3. Create a config.json file:");
    console.error("   cp config.json.example config.json");
    console.error("   # Then edit config.json with your API key\n");
    console.error("Get your API key at: https://console.deepgram.com\n");
    process.exit(1);
  }

  return apiKey;
}

const apiKey = loadApiKey();

// ============================================================================
// SETUP - Initialize Deepgram client
// ============================================================================

const deepgram = new DeepgramClient({ apiKey });

// ============================================================================
// CORS CONFIGURATION
// ============================================================================

/**
 * Standard CORS headers for cross-origin requests.
 * Applied to all API responses.
 */
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ============================================================================
// TYPES - TypeScript interfaces for request/response
// ============================================================================

interface ErrorResponseBody {
  error: {
    type: "ValidationError" | "GenerationError" | "AuthenticationError";
    code: string;
    message: string;
    details: {
      originalError: string;
    };
  };
}

// ============================================================================
// HELPER FUNCTIONS - Modular logic for easier understanding and testing
// ============================================================================

/**
 * Validates that text was provided in the request
 * @param text - Text string from request body
 * @returns true if text is valid, false otherwise
 */
function validateTextInput(text: unknown): text is string {
  return typeof text === "string" && text.trim().length > 0;
}

/**
 * Converts a ReadableStream to a Uint8Array buffer
 * @param stream - The ReadableStream to convert
 * @returns The buffer containing all stream data
 */
async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  // Concatenate all chunks into a single Uint8Array
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Generates audio from text using Deepgram's text-to-speech API
 * @param text - The text to convert to speech
 * @param model - Model name to use (e.g., "aura-2-thalia-en")
 * @returns The audio buffer
 */
async function generateAudio(
  text: string,
  model: string = DEFAULT_MODEL
): Promise<Buffer> {
  const response = await deepgram.speak.v1.audio.generate({ text, model });
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Formats error responses in a consistent structure matching the contract
 * @param error - The error that occurred
 * @param statusCode - HTTP status code to return
 * @param errorCode - Contract error code (EMPTY_TEXT, INVALID_TEXT, TEXT_TOO_LONG, MODEL_NOT_FOUND)
 * @returns Formatted error Response
 */
function formatErrorResponse(
  error: Error,
  statusCode: number = 500,
  errorCode?: string
): Response {
  // Map status codes and error messages to contract error codes
  let contractCode = errorCode;
  if (!contractCode) {
    if (statusCode === 400) {
      const msg = error.message.toLowerCase();
      if (msg.includes("empty")) {
        contractCode = "EMPTY_TEXT";
      } else if (msg.includes("model")) {
        contractCode = "MODEL_NOT_FOUND";
      } else if (msg.includes("long")) {
        contractCode = "TEXT_TOO_LONG";
      } else {
        contractCode = "INVALID_TEXT";
      }
    } else {
      contractCode = "INVALID_TEXT";
    }
  }

  const body: ErrorResponseBody = {
    error: {
      type: statusCode === 400 ? "ValidationError" : "GenerationError",
      code: contractCode,
      message: error.message || "An error occurred during audio generation",
      details: {
        originalError: error.toString(),
      },
    },
  };

  return Response.json(body, {
    status: statusCode,
    headers: corsHeaders,
  });
}

// ============================================================================
// SESSION ROUTE HANDLERS
// ============================================================================

/**
 * GET /api/session
 * Issues a signed JWT session token.
 */
function handleGetSession(): Response {
  const token = jwt.sign(
    { iat: Math.floor(Date.now() / 1000) },
    SESSION_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
  return Response.json({ token }, { headers: corsHeaders });
}

/**
 * Validates JWT from Authorization header.
 * Returns error Response or null if valid.
 */
function checkAuth(req: Request): Response | null {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return Response.json(
      {
        error: {
          type: "AuthenticationError",
          code: "MISSING_TOKEN",
          message: "Authorization header with Bearer token is required",
        },
      },
      { status: 401, headers: corsHeaders }
    );
  }

  try {
    const token = authHeader.slice(7);
    jwt.verify(token, SESSION_SECRET);
    return null;
  } catch (err) {
    const error = err as Error;
    return Response.json(
      {
        error: {
          type: "AuthenticationError",
          code: "INVALID_TOKEN",
          message:
            error.name === "TokenExpiredError"
              ? "Session expired, please refresh the page"
              : "Invalid session token",
        },
      },
      { status: 401, headers: corsHeaders }
    );
  }
}

// ============================================================================
// API ROUTE HANDLERS
// ============================================================================

/**
 * POST /api/text-to-speech
 *
 * Contract-compliant text-to-speech endpoint per starter-contracts specification.
 * Accepts:
 * - Query parameter: model (optional)
 * - Body: JSON with text field (required)
 *
 * Returns:
 * - Success (200): Binary audio data (audio/mpeg)
 * - Error (4XX): JSON error response matching contract format
 */
async function handleTextToSpeech(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const model = url.searchParams.get("model") || DEFAULT_MODEL;
    const body = await req.json();
    const { text } = body;

    // Validate input - text is required
    if (!text) {
      return formatErrorResponse(
        new Error("Text parameter is required"),
        400,
        "EMPTY_TEXT"
      );
    }

    if (!validateTextInput(text)) {
      return formatErrorResponse(
        new Error("Text must be a non-empty string"),
        400,
        "EMPTY_TEXT"
      );
    }

    // Generate audio from text
    const audioBuffer = await generateAudio(text, model);

    // Return binary audio data with proper audio mime type
    return new Response(audioBuffer, {
      headers: {
        "Content-Type": "audio/mpeg",
        ...corsHeaders,
      },
    });
  } catch (err) {
    console.error("Text-to-speech error:", err);
    const error = err instanceof Error ? err : new Error(String(err));
    const errorMsg = error.message.toLowerCase();

    // Determine error type and status code based on error message
    let statusCode = 500;
    let errorCode: string | undefined;

    // Check for model-related errors
    if (errorMsg.includes("model") || errorMsg.includes("not found")) {
      statusCode = 400;
      errorCode = "MODEL_NOT_FOUND";
    }
    // Check for text length errors
    else if (
      errorMsg.includes("too long") ||
      errorMsg.includes("length") ||
      errorMsg.includes("limit") ||
      errorMsg.includes("exceed")
    ) {
      statusCode = 400;
      errorCode = "TEXT_TOO_LONG";
    }
    // Check for invalid text errors
    else if (errorMsg.includes("invalid") || errorMsg.includes("malformed")) {
      statusCode = 400;
      errorCode = "INVALID_TEXT";
    }

    return formatErrorResponse(error, statusCode, errorCode);
  }
}

/**
 * GET /api/metadata
 *
 * Returns metadata about this starter application from deepgram.toml
 * Required for standardization compliance
 */
function handleMetadata(): Response {
  try {
    const tomlPath = path.join(import.meta.dir, "deepgram.toml");
    const tomlContent = fs.readFileSync(tomlPath, "utf-8");
    const tomlConfig = TOML.parse(tomlContent) as Record<string, unknown>;

    if (!tomlConfig.meta) {
      return Response.json(
        {
          error: "INTERNAL_SERVER_ERROR",
          message: "Missing [meta] section in deepgram.toml",
        },
        { status: 500, headers: corsHeaders }
      );
    }

    return Response.json(tomlConfig.meta, { headers: corsHeaders });
  } catch (error) {
    console.error("Error reading metadata:", error);
    return Response.json(
      {
        error: "INTERNAL_SERVER_ERROR",
        message: "Failed to read metadata from deepgram.toml",
      },
      { status: 500, headers: corsHeaders }
    );
  }
}

/**
 * GET /health
 *
 * Simple health check endpoint for monitoring
 */
function handleHealth(): Response {
  return Response.json({ status: "ok" }, { headers: corsHeaders });
}

// ============================================================================
// CORS PREFLIGHT HANDLER
// ============================================================================

/**
 * Handle CORS preflight OPTIONS requests
 */
function handlePreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

// ============================================================================
// MAIN REQUEST HANDLER
// ============================================================================

/**
 * Main request handler that routes all incoming requests.
 * Uses Bun.serve() pattern with URL-based routing.
 */
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handlePreflight();
  }

  // Session route (unprotected)
  if (req.method === "GET" && url.pathname === "/api/session") {
    return handleGetSession();
  }

  // Health check (unprotected)
  if (req.method === "GET" && url.pathname === "/health") {
    return handleHealth();
  }

  // Metadata (unprotected)
  if (req.method === "GET" && url.pathname === "/api/metadata") {
    return handleMetadata();
  }

  // Text-to-speech (auth required)
  if (req.method === "POST" && url.pathname === "/api/text-to-speech") {
    const authError = checkAuth(req);
    if (authError) return authError;
    return handleTextToSpeech(req);
  }

  // 404 for all other routes
  return Response.json(
    { error: "Not Found", message: "Endpoint not found" },
    { status: 404, headers: corsHeaders }
  );
}

// ============================================================================
// SERVER START
// ============================================================================

console.log("\n" + "=".repeat(70));
console.log(`\uD83D\uDE80 Backend API running at http://localhost:${config.port}`);
console.log(`\uD83D\uDCE1 GET  /api/session`);
console.log(`\uD83D\uDCE1 POST /api/text-to-speech (auth required)`);
console.log(`\uD83D\uDCE1 GET  /api/metadata`);
console.log(`\uD83D\uDCE1 GET  /health`);
console.log("=".repeat(70) + "\n");

Bun.serve({
  port: config.port,
  hostname: config.host,
  fetch: handleRequest,
});
