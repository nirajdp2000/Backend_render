import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";

const LOG_DIR = path.join(process.cwd(), "logs");
const ARCHIVE_DIR = path.join(LOG_DIR, "archive");
const ACTION_LOG_FILE = path.join(LOG_DIR, "server-actions.log");
const ERROR_LOG_FILE = path.join(LOG_DIR, "server-errors.log");
const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024;
const SENSITIVE_KEY_PATTERN = /(authorization|token|api[_-]?key|secret|password|cookie|session)/i;

type LogContext = Record<string, unknown>;

const ensureLogDirectories = () => {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }
};

const rotateIfNeeded = (filePath: string) => {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const { size } = fs.statSync(filePath);
  if (size < MAX_LOG_SIZE_BYTES) {
    return;
  }

  const parsed = path.parse(filePath);
  const archivedFileName = `${parsed.name}.${new Date().toISOString().replace(/[:.]/g, "-")}${parsed.ext}`;
  fs.renameSync(filePath, path.join(ARCHIVE_DIR, archivedFileName));
};

const truncateString = (value: string) => {
  if (value.length <= 200) {
    return value;
  }

  return `${value.slice(0, 197)}...`;
};

const summarizeValue = (value: unknown, depth = 0): unknown => {
  if (value === null || value === undefined) {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack?.split("\n").slice(0, 6).join(" | "),
    };
  }

  if (typeof value === "string") {
    return truncateString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    if (depth >= 1) {
      return { type: "array", length: value.length };
    }

    return {
      type: "array",
      length: value.length,
      sample: value.slice(0, 3).map((item) => summarizeValue(item, depth + 1)),
    };
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const summary: Record<string, unknown> = {};

    entries.slice(0, 12).forEach(([key, entryValue]) => {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        summary[key] = "[REDACTED]";
        return;
      }

      if (depth >= 1 && typeof entryValue === "object" && entryValue !== null) {
        summary[key] = Array.isArray(entryValue)
          ? `array(${entryValue.length})`
          : "object";
        return;
      }

      summary[key] = summarizeValue(entryValue, depth + 1);
    });

    if (entries.length > 12) {
      summary.__truncated = `${entries.length - 12} more field(s)`;
    }

    return summary;
  }

  return String(value);
};

const writeLogLine = (filePath: string, payload: Record<string, unknown>) => {
  // Vercel has a read-only filesystem — skip file writes, use stdout only
  if (process.env.VERCEL) {
    const level = (payload.level as string) || "INFO";
    const out = level === "ERROR" ? console.error : console.log;
    out(JSON.stringify(payload));
    return;
  }
  ensureLogDirectories();
  rotateIfNeeded(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
};

export const logAction = (event: string, context: LogContext = {}) => {
  writeLogLine(ACTION_LOG_FILE, {
    timestamp: new Date().toISOString(),
    level: "INFO",
    event,
    context: summarizeValue(context),
  });
};

export const logError = (event: string, error: unknown, context: LogContext = {}) => {
  writeLogLine(ERROR_LOG_FILE, {
    timestamp: new Date().toISOString(),
    level: "ERROR",
    event,
    context: summarizeValue(context),
    error: summarizeValue(error),
  });
};

export const requestLoggingMiddleware = (): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = req.header("X-Request-Id")?.trim() || randomUUID();
    const startedAt = process.hrtime.bigint();

    res.locals.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);

    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      logAction("request.completed", {
        requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
        query: summarizeValue(req.query),
        body: req.method === "GET" ? undefined : summarizeValue(req.body),
      });
    });

    next();
  };
};

export const withErrorBoundary = (handler: RequestHandler): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      Promise.resolve(handler(req, res, next)).catch(next);
    } catch (error) {
      next(error);
    }
  };
};

export const errorLoggingMiddleware: ErrorRequestHandler = (error, req, res, next) => {
  const requestId = res.locals.requestId || req.header("X-Request-Id") || randomUUID();
  const statusCode = typeof res.statusCode === "number" && res.statusCode >= 400 ? res.statusCode : 500;

  logError("request.failed", error, {
    requestId,
    method: req.method,
    path: req.originalUrl,
    statusCode,
  });

  if (res.headersSent) {
    next(error);
    return;
  }

  res.status(statusCode).json({
    error: "Unexpected server error",
    requestId,
  });
};

export const installProcessErrorHandlers = () => {
  process.on("uncaughtException", (error) => {
    logError("process.uncaughtException", error);
  });

  process.on("unhandledRejection", (reason) => {
    logError("process.unhandledRejection", reason instanceof Error ? reason : new Error(String(reason)));
  });
};
